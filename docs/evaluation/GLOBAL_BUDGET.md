# Presupuesto compartido y preparación de Gemini

Fecha: 29 de octubre de 2026, Asia/Taipei. Código validado:
`e870b21057eed5566c5ae3fe52ae5a4521e4e250` para el runtime;
`064f820cf273c13a358783ed1bb61c4327fca3a3` para el sondeo real posterior.

## Alcance implementado

Las dos rutas de inferencia del runtime pasan por `GlobalInferenceBudget`:
el cliente HTTP del padre y el cliente SDK usado por planificadores y workers
locales. El registro reside en el mismo SQLite del runtime y se comparte entre
conexiones y procesos que abren ese archivo. No depende de la tabla antigua de
estimaciones de inferencia ni de los precios de ejemplo del registro de modelos.

Antes de cada petición se reserva una cota de coste y una solicitud. La
transacción SQLite inmediata impide que dos procesos consuman el último cupo.
Los reintentos y cambios de proveedor también deben reservar otro intento.
Se desactivaron los reintentos internos del SDK y del transporte HTTP de
inferencia para evitar intentos invisibles para el contador.

El operador debe proporcionar precios explícitos por proveedor/modelo, su
caducidad, límites de tokens y topes diarios, mensuales y por petición. La
moneda de este registro es USD en **microunidades: 1 USD = 1.000.000 micros**.
Los días y meses son UTC y se asignan al momento de reservar la petición.
Los límites monetarios en cero nunca significan «sin límite». Una ruta de
coste cero solo puede funcionar con política habilitada y cupos explícitos de
solicitudes; así también se limita el trabajo con modelos gratuitos.

Para reservar se toma el tamaño UTF-8 de la petición serializada, se añaden
4.096 tokens de margen de protocolo y se incluye toda la salida permitida.
La petición saliente queda limitada por el máximo de salida del operador.
Es una estimación deliberadamente conservadora, no una factura del proveedor.

**Las reservas no se devuelven en esta primera versión.** Una llamada fallida,
un stream sin uso informado o una interrupción del proceso conserva el coste
reservado. Una respuesta correcta guarda además el coste observado, pero no
libera la diferencia. Esto puede detener la prueba antes de consumir el dinero
realmente disponible; evita gastar una reserva que quizá ya se cobró.
Si el proveedor comunica un uso mayor que el reservado, el registro bloquea
peticiones posteriores y requiere revisión. No puede deshacer un cargo ya
incurrido ni garantizar una factura si el precio o la semántica del proveedor
no coinciden con lo declarado por el operador.

La política normalizada se fija mediante un hash en SQLite. Reiniciar, cambiar
de sesión, crear otro cliente o aumentar límites en el JSON no reinicia ni
relaja el contador. Cambiar esa política exige una migración explícita del
operador que conserve la contabilidad; no se incluye una herramienta para
incrementarla automáticamente. Nunca borrar el registro para reanudar un tope.

## Arranque normal

`--run` exige configuración existente y un archivo de política en
`inferenceBudgetPath` o `~/.automaton/inference-budget.json`. La validación del
presupuesto precede a la carga de una billetera o al registro externo. Ya no
inicia automáticamente el asistente de alta. El asistente `--setup` sigue siendo
una acción separada y no se ejecutó.

En ese arranque se mantienen los pagos desactivados y `maxChildren=0`.
También se rechaza un estado que contenga hijos remotos activos: sus bases
separadas no pueden compartir este registro. Los workers locales sí comparten
el controlador. Un fallo de presupuesto detiene el ciclo, espera la salida de
los workers, guarda el motivo y detiene el heartbeat. Un reinicio posterior
del runtime requiere revisar el motivo de parada persistido.

Esto controla las rutas conocidas de inferencia. **No es un aislamiento contra
shell, código hostil, automodificación ni modificaciones del archivo SQLite.**
Para operación real sigue siendo necesario un entorno que proteja código,
secretos y registro, y comprobar los límites de facturación del proveedor.
Tampoco suma servidores externos, otras aplicaciones de la cuenta o modelos
invocados fuera de estos clientes.

## Prueba preparada de Gemini

Se preparó un proveedor explícito mediante el [endpoint compatible documentado
por Google](https://ai.google.dev/gemini-api/docs/openai). Solo existe un modelo
configurado por el operador, sin proveedor alternativo automático. El sondeo
es una petición de texto fijo, sin herramientas, con máximo de 256 tokens de
salida. No conecta todavía Gemini al ciclo comercial completo.

```sh
node dist/evaluation/gemini-probe.js --check
```

`--check` no abre la base ni llama al proveedor. Solo imprime nombres fijos de
requisitos pendientes y booleanos; no imprime claves ni contenido de la
política. El workflow de evaluación lo ejecuta en un contenedor sin red. Que
el paso termine correctamente significa que se pudo comprobar la preparación,
no que exista una conexión real con Gemini.

`--live` permanece bloqueado hasta reunir:

| Configuración privada o confirmación | Propósito |
| --- | --- |
| `GEMINI_API_KEY` | Clave del proyecto que el propietario confirme como gratuito |
| `GEMINI_MODEL` | Identificador explícito, sin elegir un modelo automáticamente |
| `GEMINI_FREE_TIER_CONFIRMED=true` | Declaración del propietario sobre el proyecto de esa clave |
| `GEMINI_LIVE_PROBE_APPROVED=true` | Autorización explícita de la prueba única |
| `GEMINI_BUDGET_DB_PATH` | Ruta absoluta en almacenamiento persistente, fuera de directorios temporales |
| `GEMINI_BUDGET_POLICY_JSON` | Política habilitada para ese modelo y proveedor |

El sondeo solo admite topes de dinero **cero**, precios declarados de capa
gratuita, una solicitud diaria y entre una y cinco mensuales. No admite una
política de pago como alternativa. El archivo
[inference-budget.disabled.example.json](inference-budget.disabled.example.json)
es una plantilla bloqueada: tiene política desactivada, modelo sin confirmar y
precio caducado. No es una autorización para operar.

El modelo `gemini-3.5-flash-lite` figura en la [documentación actual del
modelo](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) y en
la [tabla de precios de Google](https://ai.google.dev/gemini-api/docs/pricing).
La existencia de una capa gratuita en la tabla no demuestra que una clave
concreta pertenezca a un proyecto gratuito ni que tenga cuota disponible.
El propietario confirmó que el proyecto es gratuito y se realizó después
una petición real limitada; ver el resultado y alcance al final del documento.

La clave debe cargarse por el propietario en un gestor de secretos del entorno
elegido. Para la comprobación de GitHub, el nombre del secreto es
`GEMINI_API_KEY` y el modelo se configura como variable `GEMINI_MODEL`.
No poner la clave en código, conversaciones, archivos de política ni informes.
El conector de GitHub disponible no administra secretos, por lo que ese paso
requiere intervención del propietario. La elección y conexión del alojamiento
persistente también siguen pendientes; no se contrató infraestructura.

## Verificación

La suite completa aprobó 1.675 pruebas en 67 archivos. Incluye concurrencia
entre dos procesos independientes, persistencia tras cerrar y reabrir SQLite,
topes combinados entre padre y workers/proveedores, reintentos, streams sin
uso informado, bloqueo sin presupuesto, y parada del ciclo por presupuesto.
La revisión de tipos y construcción pasaron; la auditoría de dependencias de
producción sigue sin avisos conocidos. Las cuatro pruebas de la misión
simulada también pasaron. Los resultados y enlaces de GitHub se guardan en
[global-budget-results.json](global-budget-results.json).

Estado actual: conexión real de una petición comprobada tras la confirmación
del proyecto gratuito. Sigue pendiente un servicio persistente y la adaptación
al ciclo completo; no hay automatización de gasto activa.

## Resultado real y siguiente acceso necesario

### Actualización: proyecto gratuito confirmado y sondeo único

El propietario confirmó el 29 de octubre que la clave guardada corresponde
a un proyecto gratuito sin facturación. GitHub detectó la clave en una
comprobación sin red; el sondeo real posterior también terminó correctamente.

Se preparó `gemini-once.yml`: una prueba finita en el fork público, sin
contratar servidor. Usa el modelo candidato ya documentado,
`gemini-3.5-flash-lite`, cuya capa gratuita se volvió a verificar en la tabla
oficial. Configura una petición como máximo, cero dinero y 256 tokens de
salida. La política caduca el 1 de noviembre de 2026 a las 00:00 de Taiwán.

Antes de llamar al proveedor, el workflow crea exclusivamente la referencia
`refs/tags/evaluation/gemini-free-probe-v1-reserved` mediante un POST a GitHub.
Solo una creación confirmada autoriza continuar. La referencia persiste fuera
del runner; si ya existe, hay un error de permisos o la respuesta es ambigua,
el proceso falla sin llamar a Gemini. Nunca se borra para reintentar, incluso
si la llamada falla o el runner se interrumpe. Así no se depende de restaurar
una caché o un artefacto para impedir otro intento. La exclusión depende de
que el propietario conserve la referencia y no altere el workflow.

El contenedor de inferencia recibe únicamente la clave de Gemini, las opciones
públicas del sondeo y un directorio SQLite dedicado. No recibe el token de
GitHub, herramientas de agente, billetera ni montajes del repositorio. El
archivo SQLite se conserva como artefacto contable durante 30 días; la reserva
en GitHub sigue existiendo aunque el artefacto caduque. No contiene claves ni
prompts. No se activa horario recurrente ni ejecución comercial.

Esta reserva duradera resuelve la contabilidad de **un solo sondeo** en un
runner efímero. No proporciona almacenamiento operativo continuo ni sustituye
el alojamiento pendiente para un agente 24/7. El presupuesto cero sigue siendo
contabilidad de aplicación apoyada en la confirmación del plan gratuito;
no modifica la facturación de Google.

### Resultado verificado

La [prueba en GitHub](https://github.com/JonathanShynn/automaton/actions/runs/40861242593)
terminó correctamente: Gemini devolvió una respuesta no vacía, con 10 tokens de
entrada y 6 de salida. La reserva se confirmó antes del transporte y permanece
intacta. Se descargó el artefacto contable, se verificó su SHA-256 contra GitHub
y la integridad SQLite: contiene exactamente una petición completada y cero
microunidades en reservas, cargos y coste observado. Es contabilidad bajo el
plan gratuito confirmado; no se consultó la factura de Google. No se guarda
el texto de la respuesta ni la clave en el informe.

La suite volvió a aprobar 1.675 pruebas en 67 archivos con Node 20 y Node 22 en
[CI](https://github.com/JonathanShynn/automaton/actions/runs/40861250026), y la
auditoría de dependencias de producción no encontró avisos conocidos. Las
cinco pruebas de la reserva y las 21 regresiones de presupuesto pasaron también
sin red. [Evidencia](global-budget-results.json).

### Continuidad pendiente

La clave, el plan gratuito y la conexión al proveedor ya están comprobados.
Este sondeo no ejecuta el ciclo completo de Automaton: el arranque principal
sigue cargando una identidad/billetera y un cliente Conway. La adaptación de
Gemini al ciclo real y la revisión de esa dependencia continúan pendientes;
no debe confundirse el sondeo con una instalación operativa del agente.

Se encontró una integración de Railway para inspeccionar alojamiento y
volúmenes persistentes, pero no está conectada. El próximo acceso solicitado
es instalar/conectar Railway con la cuenta del propietario. Se revisarán las
opciones de esa cuenta antes de aprovisionar recursos. No se creó un servicio
ni se activó una suscripción. Los créditos gratuitos limitados no son una
promesa de operación gratuita continua.

Para continuar, conservar la reserva del sondeo; no borrarla ni cambiar su
nombre para repetir una llamada. No activar facturación para resolver falta
de cuota. El proyecto AgentZero original permanece sin cambios. No existe aún
un servicio 24/7, validación comercial ni ingreso real demostrado.
