# Ciclo de investigación con Gemini

Fecha: 29 de octubre de 2026 (Taiwán).

Actualización del 30 de octubre: [continuidad con seis ciclos simulados y ensayos
de interrupción](CONTINUITY.md). No se realizaron nuevas peticiones reales.

## Resultado actual: ciclo real y checkpoint comprobados

El propietario autorizó dos solicitudes gratuitas adicionales. La primera produjo
JSON válido que no cumplía el esquema del adaptador (código 4). No se registró qué
campo concreto falló. Se hizo opcional el comentario explicativo, manteniendo la
validación estricta de acciones, y se añadió un ejemplo JSON explícito a la misión.
La segunda solicitud completó un turno real del motor con Gemini y guardó el dato
sintético en SQLite. Una nueva ejecución de proceso y contenedor, sin red ni clave
de Gemini, abrió la base en modo de solo lectura y recuperó la memoria.

[Ensayo correcto](https://github.com/JonathanShynn/automaton/actions/runs/40885491982).
El proceso del ciclo alcanzó 172 MiB de RSS máxima; el verificador, 103 MiB. Esto
solo mide una ejecución corta. No demuestra consumo sostenido, una segunda decisión
del modelo tras el reinicio, operación 24/7 ni validación comercial.

Las dos solicitudes autorizadas se consumieron. Cada una tiene una reserva externa
independiente que el programa nunca elimina: `gemini-research-trial-v2-slot-1`
y `gemini-research-trial-v2-slot-2`. Las reservas anteriores siguen intactas. El
workflow queda desactivado otra vez (`if: false`); no hay inferencia recurrente.
La base y los textos de ejecución no se subieron como artefactos ni se publicaron
en logs: solo se publicaron los indicadores enteros/booleanos permitidos.

El código probado es `8b2ab0f47e40692195580297dc808137f572412c`. La
[CI](https://github.com/JonathanShynn/automaton/actions/runs/40885500758) aprobó
1.691 pruebas en 68 archivos con Node 20 y Node 22, tipos y auditoría de producción
sin avisos conocidos. La evaluación aislada pasó también. Las nuevas reservas
pasaron cuatro pruebas de concurrencia, reinicio y fallo cerrado; las pruebas
focalizadas del adaptador y checkpoint suman 16.
[Evidencia actual](research-retry-results.json).

No se contrató alojamiento ni se activó facturación. Para operación permanente
faltan decidir alojamiento y presupuesto, autorizar cuotas/frecuencia de inferencia,
y comprobar repetición de ciclos, recuperación y crecimiento del historial. El
workspace de Render pendiente de confirmar sigue siendo `My Workspace`.

Los apartados siguientes conservan el diseño y la evaluación anterior como historial.

## Qué cambia

`runGeminiResearchCycle` conecta el motor real `runAgentLoop` a Gemini mediante
un perfil explícito `researchOnly`. Usa el SQLite real del motor y un presupuesto
compartido. No carga ni genera billetera, no construye un cliente Conway ni consulta
saldos de blockchain. La identidad interna es una etiqueta no operativa; cualquier
intento de acceder a su cuenta o a Conway produce un error.

El perfil ofrece únicamente `remember_fact`, `recall_facts` y `sleep`. Ignora las
herramientas instaladas y desactiva orquestación, workers, replicación, redes
sociales y descubrimiento Ollama. Exige pagos desactivados, cero hijos y de uno
a cinco turnos por ciclo. Su prompt describe esas capacidades limitadas y no
presenta al modelo como propietario de una billetera o servidor Conway.

El adaptador usa un protocolo JSON de acciones locales, no llamadas nativas a
funciones del proveedor. Convierte el historial de acciones y resultados en texto,
por lo que no elimina ni inventa firmas de pensamiento Gemini. Solo acepta
acciones ofrecidas, con argumentos de objeto y un máximo de tres por respuesta.
No admite streaming, cambio de modelo, otro endpoint ni proveedores alternativos.
El SDK no reintenta. Los errores detienen el ciclo, se redactan y quedan marcados
para revisión. El presupuesto reserva antes de cada petición, conserva intentos
fallidos y persiste al cerrar la base.

Este perfil no cambia `--run`: el arranque general todavía conserva las capacidades
y dependencias Conway descritas por upstream. El perfil acotado permite evaluar
memoria y decisiones sin activar esa infraestructura. No es aún un investigador
con navegador, herramientas comerciales o ejecución continua.

## Ensayo preparado

`research-trial.ts --store` pide guardar una oferta ficticia y entrar en reposo.
`--resume`, en otro proceso y contenedor, exige encontrar ese checkpoint, pide
recuperarlo y vuelve a reposo. Cada proceso tiene un solo turno. Ambos comparten
SQLite; se comprueba una petición por fase y dos como máximo para toda la misión.
Los datos declaran ingreso real cero y ausencia de validación de mercado.

El workflow `gemini-research.yml` reserva la misión mediante la referencia fija
`refs/tags/evaluation/gemini-research-trial-v1-reserved`. La reserva se mantiene
incluso si falla una fase; no se borra para reintentar. No cambia la reserva del
sondeo anterior. La política permite dos solicitudes y cero dinero; caduca el
1 de noviembre de 2026 a las 00:00 de Taiwán. Se basa en la confirmación del
propietario del proyecto gratuito, no en acceso a una factura de Google.

La base contiene memoria, historial y contabilidad del ensayo sintético. No se
sube como artefacto. La revisión automática rechazó una versión que la publicaba;
se eliminó esa subida. Los registros de modelo quedan en archivos temporales del
runner y tampoco se publican. Solo sale un resumen de enteros y booleanos con
campos fijos: solicitudes, turnos, recuperación, hijos, ingresos y memoria máxima.
La reserva externa es duradera; el disco del runner no es alojamiento permanente.

## Validación y continuidad

El código `99d6f8da7b64485daef26df270d2f2a724d22cd9` aprobó 1.685 pruebas en
68 archivos con Node 20 y 22, tipos y auditoría de producción sin avisos conocidos:
https://github.com/JonathanShynn/automaton/actions/runs/40880181500
La evaluación aislada también aprobó:
https://github.com/JonathanShynn/automaton/actions/runs/40880172030
El ensayo de dos peticiones se ejecuta sobre:
https://github.com/JonathanShynn/automaton/actions/runs/40880855069
La primera fase real terminó con código de salida 1 y no produjo un checkpoint
verificado. La fase de recuperación no se ejecutó. La reserva se conserva y el
workflow se retiró (`if: false`) para impedir nuevas llamadas automáticas. No
se dispone del motivo exacto ni del número real de peticiones: los registros
privados del runner no se publicaron ni conservaron como artefactos. La fase
fallida podía hacer como máximo una petición, sin reintentos.

Se añadieron después diagnósticos de campos fijos: 1 transporte, 2 respuesta
incompleta, 3 JSON inválido, 4 esquema inválido, 5 acción no permitida y 6 fallo
de las comprobaciones del ensayo. No estuvieron presentes en la ejecución
fallida; no deben usarse para atribuirle una causa. Catorce pruebas focalizadas
pasaron localmente, incluidas respuestas truncadas, errores de JSON y herramientas
inventadas. Otro ensayo real requiere revisión y autorización del propietario;
no borrar ni reutilizar la reserva consumida. El resultado se registra en
`research-cycle-results.json`.

No se creó un servicio Render ni se autorizó gasto. Render está conectado; se
encontró `My Workspace`, pero sigue pendiente que el propietario confirme ese
espacio antes de inspeccionar sus recursos. Railway no admite nuevas cuentas en
la comprobación del 29 de octubre y no debe proponerse como siguiente registro.
Supabase periódico implicaría otra arquitectura y no se ha implementado.

Tras este ensayo, falta preparar y evaluar almacenamiento continuo, recuperación
en un host persistente, retención del historial, cuotas del uso sostenido y tareas
comerciales con datos reales. Medir un proceso corto no prueba operación 24/7 ni
que 512 MB alcancen al crecer el historial. AgentZero original permanece intacto.

La versión con diagnósticos `025cede808d008abce5f177a0faa450c8ed21e86` aprobó
1.689 pruebas en 68 archivos con Node 20 y 22, tipos y auditoría de producción:
https://github.com/JonathanShynn/automaton/actions/runs/40881644989
La evaluación aislada aprobó y el ensayo real retirado se omitió, como estaba
previsto. Estas comprobaciones no hicieron más llamadas reales a Gemini.
