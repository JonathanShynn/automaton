# Correcciones y segunda validación

Registro de la segunda fase. La siguiente fase implementa el presupuesto
compartido y prepara Gemini: [GLOBAL_BUDGET.md](GLOBAL_BUDGET.md).

Fecha: 29 de octubre de 2026, Asia/Taipei.
Código evaluado: `b973db92434150a4fe54b81a7d298270e1eb59eb`.

El fork conserva la evaluación aislada y ahora corrige los bloqueos iniciales:
dependencias de producción con avisos conocidos, operaciones económicas
habilitadas implícitamente, propagación del límite de hijos y una operación
de tokenización que impedía terminar la batería completa.

## Cambios

- **Dependencias:** `simple-git` 4.0.2 y `yaml` 2.9.1. Las resoluciones
  transitivas fijan versiones parcheadas de `ws`, `js-yaml` y `uuid`. Jayson 5
  elimina la antigua dependencia de `stream-json`. Se conserva el SDK Solana
  1.98.4; se comprueba su transporte HTTP JSON-RPC con una respuesta simulada,
  además de inicialización, commit y consulta de estado con `simple-git` 4.
- **Operaciones económicas:** `financialOperationsEnabled` se interpreta como
  desactivado si falta o no es el booleano literal `true`. Los clientes Conway,
  incluidos los clientes asociados a otro sandbox, bloquean transferencias,
  creación de sandboxes y registro de dominios antes de la petición HTTP.
  Las recargas de inicio, heartbeat y errores de sandbox se omiten antes de
  consultar el saldo. El transporte x402 deniega la firma de un pago solicitado
  por HTTP 402 si falta ese permiso. No se habilitó el permiso ni se configuró
  una billetera real.
- **Límite de hijos:** los llamadores pasan la configuración del padre a
  `spawnChild`; ya no se busca una propiedad inexistente en la base de datos.
  Cero bloquea el aprovisionamiento y valores negativos, fraccionarios o no
  finitos se rechazan. La reserva concurrente de cupos aún no es atómica.
- **Trabajo de tokenización:** para entradas superiores a 16.384 caracteres
  se usa el número de bytes UTF-8 como cota conservadora de tokens y no se
  conserva la entrada grande como clave de caché. Esto evita el trabajo muy
  costoso de BPE sobre texto repetitivo de cientos de miles de caracteres.
  Puede resumirse el contexto antes de lo estrictamente necesario; no es una
  cuenta exacta de tokens para entradas grandes.
- **Pruebas y CI:** las consultas de saldo/discovery del test del ciclo se
  simulan. La batería requiere transportes HTTP simulados y corre con sockets
  denegados. CI ya no convierte timeouts en éxito, ni oculta la auditoría con
  `|| true`; los scripts de seguridad usan archivos de pruebas válidos en vez
  de `--grep`, que Vitest 2.1.9 no admite.

## Resultados del entorno de trabajo

| Verificación | Resultado |
| --- | --- |
| Revisión de tipos del runtime, evaluación y test nuevo | Correcta |
| Construcción del motor y CLI | Correcta |
| Suite completa | 1.654 pruebas correctas, 65 archivos, 39,82 segundos |
| Misión simulada y recuperación | 4 pruebas correctas |
| Auditoría de producción | 0 avisos conocidos de cualquier severidad; código de salida 0 |
| GitHub CI, Node 20 y 22 | Suite completa y auditoría correctas en ambos jobs |
| Contenedor aislado en GitHub | Construcción correcta y 4 pruebas correctas |

La suite completa incluye diez pruebas nuevas de bloqueo financiero, límites
de hijos y compatibilidad de dependencias, además de una regresión para
entradas repetitivas y multilingües grandes. La auditoría usa `pnpm audit
--prod --json`: su alcance son las dependencias de producción, no todas las
herramientas de desarrollo ni una auditoría manual de todo el código.

Los resultados y las ejecuciones de GitHub se conservan en
[hardening-results.json](hardening-results.json). La auditoría inicial se
mantiene por separado para poder comparar.

Ejecuciones sobre este código: [CI en Node 20 y 22](https://github.com/JonathanShynn/automaton/actions/runs/40794929441) y [contenedor sin red](https://github.com/JonathanShynn/automaton/actions/runs/40794922934).

## Alcance pendiente

El bloqueo financiero es un control de aplicación, no un aislamiento contra
código hostil ni un presupuesto global. La inferencia puede consumir créditos
o API de pago incluso con pagos desactivados. El shell y la automodificación
del arranque normal tampoco quedan confinados por este cambio. Todavía no se
deben entregar credenciales personales o fondos al runtime normal.

Antes de un despliegue productivo falta un presupuesto global para todos los
proveedores y workers, permisos restringidos en el arranque real, selección de
servidor/modelo y una prueba prolongada con recuperación ante fallos. No se
han validado pagos reales, WebSocket en vivo, migración a Supabase, llamadas
reales a Gemini, ventas ni operación 24/7.

Se mantiene la recomendación de continuar en modo aislado. El proyecto Agent
Zero no se modificó y no se contrató infraestructura persistente.
