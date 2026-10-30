# Continuidad acotada y recuperación

Fecha: 30 de octubre de 2026 (Taiwán).

## Alcance

Esta fase usa el motor real `runAgentLoop`, herramientas locales y SQLite real,
con respuestas predefinidas. No llama a Gemini ni a ningún proveedor de IA, no
carga claves, no crea billeteras y no contrata infraestructura. Se ejecuta detrás
del filtro Linux que deniega sockets, incluidos los de procesos secundarios.
Los dos intentos reales autorizados anteriormente siguen consumidos; su workflow
permanece desactivado y sus referencias de reserva no se modificaron.

## Cambio implementado

`runGeminiResearchCycle` admite un `cycleId` estable. Con ese identificador,
`research_cycle_receipts` registra la admisión antes de construir el cliente del
modelo. Una transacción inmediata de SQLite excluye admisiones concurrentes.

- Un ciclo terminado con las mismas instrucciones se omite sin construir el SDK,
  sin ejecutar herramientas y sin reservar otra petición.
- Reutilizar el identificador con otra misión, modelo o límite de turnos falla.
- Un ciclo activo, interrumpido o fallido bloquea nuevos ciclos identificados en
  esa base. No caduca automáticamente ni se reintenta al reiniciar.
- Un error estructurado de herramienta, un presupuesto detenido o un ciclo que
  no persista turnos y termine en reposo requiere revisión.
- La tabla almacena un hash de las instrucciones y códigos fijos de estado;
  no almacena allí prompts, respuestas ni errores originales del proveedor.

La capa compartida `runResearchCycle` permite inyectar un cliente determinista
para evaluar exactamente el mismo perfil limitado. El punto de entrada Gemini
sigue usando exclusivamente su adaptador existente y el presupuesto compartido.

**La protección se aplica al perfil de investigación cuando se entrega un
`cycleId`.** Los llamadores antiguos sin identificador conservan su comportamiento
anterior; no se cambió el arranque general `--run`. Un futuro planificador deberá
usar un identificador estable por tarea y respetar su frecuencia de ejecución.
No basta con generar un identificador nuevo en cada reintento.

## Pruebas ejecutadas

1. Seis ciclos secuenciales en seis procesos nuevos. Cada ciclo guarda un hecho
   sintético y entra en reposo; los últimos cinco recuperan el checkpoint anterior.
2. Seis nuevos procesos repiten esos identificadores. Todos se omiten: seis
   hechos, seis turnos y seis solicitudes al cliente simulado en total.
3. `SIGKILL` después de reservar una solicitud, antes de devolver la respuesta.
   La reserva permanece y ni el mismo ciclo ni otro posterior son readmitidos.
4. `SIGKILL` después de las herramientas y antes de persistir el turno. El hecho
   existe, el turno no: el sistema conserva esa incertidumbre y bloquea el replay.
5. `SIGKILL` después de persistir el turno y antes del recibo final. La tarea no
   vuelve a ejecutarse automáticamente aunque su recibo siga incompleto.
6. Error de transporte simulado: reserva incierta y bloqueo persistente, sin un
   segundo intento. Error de herramienta: el ciclo no se certifica como terminado.
7. Presupuesto de una solicitud: un reinicio no restaura la cuota consumida.
8. Dos procesos concurrentes con el mismo identificador: una sola admisión, un
   turno y un efecto local. `PRAGMA integrity_check` devuelve `ok` tras los ensayos.

La evaluación aislada suma 12 pruebas (las cuatro anteriores más ocho de esta
fase). Las pruebas focalizadas del adaptador y recibos suman 21. Los procesos
sintéticos de seis ciclos alcanzaron 193 MiB de RSS máxima en esta ejecución local;
no es un pronóstico para un servidor permanente. La evidencia resumida queda en
[continuity-results.json](continuity-results.json).

## Límites y siguiente decisión

Esto demuestra continuidad de procesos y una política conservadora frente a
interrupciones. No demuestra una segunda decisión real de Gemini después de un
reinicio, calidad de investigación, ventas, rentabilidad ni operación de 24 horas.
El ensayo dura segundos; no simula fielmente 24 horas de carga ni historial largo.

Los efectos de herramientas y el recibo final no forman una sola transacción a
través de toda la ejecución asíncrona. Por eso no se promete ejecución exactamente
una vez: el sistema prefiere requerir revisión antes que duplicar trabajo. No hay
reparación automática de tareas ambiguas, recuperación tras pérdida del disco,
coordinación entre varias bases independientes ni protección frente a código
hostil que altere SQLite. "Terminado" es una condición operativa, no una evaluación
de que la misión comercial haya tenido éxito.

Sigue pendiente elegir alojamiento con disco persistente, definir frecuencia y
cuotas autorizadas para una prueba real de varios ciclos, comprobar el crecimiento
del historial y preparar una misión con resultados comerciales verificables.
AgentZero original permanece intacto.

## Repetición

La imagen y workflow de evaluación aislada incluyen estas pruebas. El comando
Docker documentado en el README usa ahora un límite externo de 180 segundos.
Para Linux desechable, después de compilar:

```sh
pnpm exec tsc
timeout --kill-after=10s 180s python3 scripts/evaluation/run-offline.py \
  "$(command -v node)" node_modules/vitest/vitest.mjs run \
  --config scripts/evaluation/vitest.config.ts
```

El runner sin Docker limita red y entorno, pero no aísla el sistema de archivos.
