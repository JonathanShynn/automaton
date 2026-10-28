# Evaluación aislada de Automaton para Agent Zero

Resultado y bloqueos: [ASSESSMENT.md](ASSESSMENT.md). La primera evaluación
aislada en GitHub está completada; no es un despliegue permanente.

Esta prueba ejecuta el motor real de Automaton con respuestas de modelo
predefinidas, clientes de nube simulados y SQLite real. No inicia `--run`, no
crea billeteras, no aprovisiona servicios y no requiere claves.

## Qué comprueba

- El proceso y sus hijos no pueden crear sockets IPv4/IPv6. Las variables de
  entorno heredadas y los descriptores adicionales se eliminan antes de iniciar.
- Una misión comercial ficticia escribe un archivo simulado y una memoria real,
  intenta dos acciones prohibidas y entra en reposo.
- Otro proceso lee la base SQLite cerrada; después, el motor reabre el mismo
  estado, recupera la memoria y continúa acumulando turnos.
- Las herramientas que no están en la lista de evaluación se deniegan antes de
  llegar al cliente. Esto incluye pagos, shell, replicación y automodificación.
- Una tarea programada pendiente sobrevive al cierre de la base y se ejecuta
  una sola vez al reiniciar el planificador.

La misión contiene números inventados para comprobar el flujo. No investiga
mercados ni demuestra ventas, beneficio real o calidad de razonamiento de un
modelo. Los archivos de nube se simulan; su durabilidad remota no se prueba.

## Repetir en una nube con Docker

Desde la raíz del repositorio:

```sh
docker build -t automaton-offline-evaluation -f scripts/evaluation/Dockerfile .
timeout --kill-after=10s 90s docker run --rm \
  --name automaton-offline-evaluation \
  --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --memory 2g --cpus 2 --pids-limit 128 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
  automaton-offline-evaluation
```

La construcción descarga dependencias con red. La ejecución de pruebas no
tiene red, credenciales ni carpetas del equipo montadas. El contenedor corre
como usuario no privilegiado, con el código en solo lectura y datos temporales.
Al terminar se descarta; no es un servidor permanente.

El workflow `Offline adoption evaluation` repite esta receta con límite de
12 minutos en el fork público indicado y sin secretos. Se activa al subir
cambios en la rama de evaluación y también admite ejecución manual. No tiene
cron ni reinicio infinito. GitHub puede requerir que el propietario habilite
Actions en un fork; preparar el workflow no demuestra que se haya ejecutado.

## Repetir en un entorno Linux desechable sin Docker

Requisitos: Node 22, pnpm **10.28.1**, Python 3 y libseccomp2.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm exec tsc --project scripts/evaluation/tsconfig.json
pnpm run build
timeout --kill-after=10s 90s python3 scripts/evaluation/run-offline.py \
  "$(command -v node)" node_modules/vitest/vitest.mjs run \
  --config scripts/evaluation/vitest.config.ts
```

El lanzador aborta si no puede aplicar el filtro. La opción sin Docker limita
red y entorno; **no aísla el sistema de archivos**. Debe usarse solo en una
máquina desechable que no contenga secretos. El runner no es una protección
general para ejecutar código hostil.

## Separación del arranque normal

La lista de herramientas y el presupuesto de esta prueba se construyen dentro
del test. **No se aplican al comando normal `node dist/index.js --run`.** Ese
comando conserva la configuración de upstream y puede iniciar el asistente de
alta y operaciones externas. No se debe usar como sustituto de esta receta.

El siguiente paso de adopción será elegir un servidor persistente y un modelo,
implementar las restricciones en el arranque productivo y verificar límites
globales de gasto, recuperación de fallos y operación prolongada. Ninguno de
estos puntos queda demostrado por una prueba de segundos.
