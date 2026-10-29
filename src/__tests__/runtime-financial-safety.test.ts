import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivateKeyAccount } from "viem";
import { createConwayClient } from "../conway/client.js";
import { bootstrapTopup, topupCredits, topupForSandbox } from "../conway/topup.js";
import { x402Fetch } from "../conway/x402.js";
import { spawnChild } from "../replication/spawn.js";
import { createTestConfig, createTestDb, createTestIdentity, MockConwayClient } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { simpleGit } from "simple-git";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const databases: AutomatonDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Evaluation fork financial boundaries", () => {
  it("denies transfers, new sandboxes and domains before HTTP, including scoped clients", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = createConwayClient({ apiUrl: "https://example.invalid", apiKey: "synthetic", sandboxId: "test" });
    for (const candidate of [client, client.createScopedClient("child")]) {
      await expect(candidate.transferCredits("recipient", 1)).rejects.toThrow("FINANCIAL_OPERATIONS_DISABLED");
      await expect(candidate.createSandbox({ name: "blocked" })).rejects.toThrow("FINANCIAL_OPERATIONS_DISABLED");
      await expect(candidate.registerDomain("example.invalid")).rejects.toThrow("FINANCIAL_OPERATIONS_DISABLED");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips automatic credit topups without reading a wallet or reaching HTTP", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const account = {} as PrivateKeyAccount;
    expect(await bootstrapTopup({ apiUrl: "https://example.invalid", account, creditsCents: 0 })).toBeNull();
    expect(await topupForSandbox({ apiUrl: "https://example.invalid", account, error: Object.assign(new Error("INSUFFICIENT_CREDITS"), { status: 402 }) })).toBeNull();
    await expect(topupCredits("https://example.invalid", account, 5)).rejects.toThrow("FINANCIAL_OPERATIONS_DISABLED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never signs a server-requested payment while permission is absent", async () => {
    const signTypedData = vi.fn();
    const fetch = vi.fn(async () => new Response("{}", { status: 402 }));
    vi.stubGlobal("fetch", fetch);
    const result = await x402Fetch("https://example.invalid", { signTypedData } as unknown as PrivateKeyAccount);
    expect(result.success).toBe(false);
    expect(result.error).toContain("FINANCIAL_OPERATIONS_DISABLED");
    expect(signTypedData).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])("rejects a disabled or invalid parent child limit (%s) before provisioning", async (maxChildren) => {
    const db = createTestDb(); databases.push(db);
    const conway = new MockConwayClient();
    const provision = vi.spyOn(conway, "createSandbox");
    const identity = createTestIdentity();
    await expect(spawnChild(conway, identity, db, {
      name: "synthetic", genesisPrompt: "synthetic", creatorMessage: "", creatorAddress: identity.address, parentAddress: identity.address,
    }, undefined, createTestConfig({ maxChildren }))).rejects.toThrow("Cannot spawn");
    expect(provision).not.toHaveBeenCalled();
    expect(db.getChildren()).toEqual([]);
  });
});

describe("Patched dependency compatibility", () => {
  it("preserves the Solana HTTP JSON-RPC client with the scoped Jayson update", async () => {
    const transport = vi.fn(async (_url: unknown, options?: RequestInit) => {
      const request = JSON.parse(String(options?.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { context: { slot: 1 }, value: 42 } }), { headers: { "content-type": "application/json" } });
    });
    const connection = new Connection("https://example.invalid", { fetch: transport as typeof fetch });
    expect(await connection.getBalance(new PublicKey("11111111111111111111111111111111"))).toBe(42);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("can initialize and commit a local state repository with simple-git 4", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-git-compat-"));
    try {
      const git = simpleGit(directory);
      await git.init();
      await git.addConfig("user.name", "Offline Evaluation");
      await git.addConfig("user.email", "evaluation@example.invalid");
      fs.writeFileSync(path.join(directory, "state.txt"), "synthetic state\n");
      await git.add("state.txt");
      const result = await git.commit("Synthetic state checkpoint");
      expect(result.commit).toMatch(/^[a-f0-9]+$/);
      expect((await git.status()).isClean()).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
