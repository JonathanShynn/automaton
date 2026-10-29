/** Unit tests must explicitly mock transports; never consult live services. */
globalThis.fetch = async () => {
  throw new Error("Live fetch disabled in unit tests; provide a mock transport");
};
