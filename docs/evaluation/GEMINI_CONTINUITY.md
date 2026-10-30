# Tres ciclos reales de continuidad con Gemini

Fecha: 30 de octubre de 2026 (Taiwán).

## Resultado: tres ciclos reales correctos

La [ejecución real](https://github.com/JonathanShynn/automaton/actions/runs/41009765535)
completó los tres ciclos, uno por proceso y contenedor, con exactamente tres
solicitudes a Gemini. Los tres hechos, turnos y recibos se verificaron. Las fases
2 y 3 recuperaron la memoria previa y sus cálculos coincidieron con los valores
esperados. Un cuarto proceso, sin red ni clave, volvió a abrir SQLite en modo
de solo lectura y comprobó los tres checkpoints sin solicitudes adicionales.

El código probado es `b2310ca651ca0bab56784d2f7f15e12fe9367cf0`. Los procesos
de modelo alcanzaron 170, 164 y 164 MiB de RSS máxima, respectivamente. No es una
medición sostenida ni demuestra que 512 MB alcancen para un historial prolongado.
Las tres reservas externas quedaron consumidas y el workflow se desactivó
(`if: false`); no hay nuevas llamadas automáticas ni tarea periódica.

La evidencia resumida se conserva en
[gemini-continuity-results.json](gemini-continuity-results.json). No se publicaron
la base, los registros completos de solicitudes, las respuestas reales ni los
registros completos del motor. Las instrucciones sintéticas de la prueba forman
parte del código revisable.

La [CI](https://github.com/JonathanShynn/automaton/actions/runs/41009770128)
aprobó 1.704 pruebas en 69 archivos con Node 20 y 22, tipos y auditoría de
producción sin vulnerabilidades conocidas. La
[evaluación aislada](https://github.com/JonathanShynn/automaton/actions/runs/41009765483)
aprobó las 12 pruebas de continuidad y aislamiento. Las ocho pruebas focalizadas
del ensayo con modelo simulado y las cuatro de reservas también pasaron antes
de emitir solicitudes reales.

El propietario autorizó explícitamente un nuevo ensayo de **tres solicitudes como
máximo**, una por ciclo, sin reintentos, sin habilitar facturación y sin contratar
servicios. El proyecto gratuito de Gemini fue confirmado por el propietario;
esta evaluación no accede a la facturación de Google ni cambia su configuración.
Las reservas de los ensayos anteriores permanecen consumidas e intactas.

## Misión y límites

Cada ciclo inicia un proceso y contenedor nuevos y utiliza el mismo archivo SQLite:

1. Guardar una oferta ficticia: precio 49, costo variable 9, costo fijo 20.
2. Recuperar esa memoria y calcular la contribución por venta: 40.
3. Recuperar el trabajo previo y calcular el beneficio supuesto para tres ventas:
   100. Las ventas son hipotéticas; ingreso real cero y mercado no validado.

Los ciclos 2 y 3 reciben el historial persistido y ejecutan `recall_facts` como
primera acción. Esa acción y el nuevo cálculo pertenecen al mismo turno de modelo;
no se afirma una segunda inferencia posterior al resultado de la herramienta.
Los cálculos se verifican contra resultados conocidos. Un cuarto contenedor,
sin red ni clave de IA, comprueba los tres checkpoints y la integridad de SQLite.

Modelo fijo: `gemini-3.5-flash-lite`, endpoint oficial Google, máximo 256 tokens de
salida y techo de entrada 32.768 por solicitud. El SDK no reintenta ni cambia de
modelo o proveedor. La política compartida admite tres solicitudes por día y mes,
precios declarados cero y presupuesto monetario cero; caduca el 1 de noviembre de
2026 a las 00:00 de Taiwán. Es un límite interno, no una garantía de facturación
impuesta por Google.

Únicas herramientas: memoria local y reposo. Sin billeteras operativas, pagos,
shell, herramientas comerciales, agentes secundarios ni conexión Conway.

## Reservas externas y recuperación

Cada fase tiene una referencia fija e independiente:

- `refs/tags/evaluation/gemini-continuity-v1-cycle-1-reserved`
- `refs/tags/evaluation/gemini-continuity-v1-cycle-2-reserved`
- `refs/tags/evaluation/gemini-continuity-v1-cycle-3-reserved`

La fase solo se admite si su referencia se crea por primera vez y GitHub confirma
el SHA y tipo exactos. Una reserva existente, respuesta ambigua o error de red
deniega la llamada. Nunca se borra ni se cambia de fase para eludir un error.
La siguiente reserva solo se crea después de verificar la fase anterior.

El presupuesto y los recibos con `cycleId` se comparten en SQLite. La pérdida del
runner no permite repetir las fases ya reservadas porque sus referencias siguen
en GitHub. El workflow no contiene cron; se retirará al finalizar el ensayo.
Una barrera adicional por proceso admite una sola entrada al presupuesto, incluso
si ocurre un error interno después de recibir la respuesta del proveedor.

## Privacidad y alcance de la evidencia

El token GitHub solo llega a los pasos de reserva; la clave de Gemini solo a los
contenedores de modelo y preflight. La construcción no recibe credenciales.
La salida completa del motor se redirige a archivos privados y efímeros del runner.
Solo se publican campos numéricos/booleanos permitidos. No se suben bases SQLite,
registros de solicitudes, respuestas ni registros completos como artefactos.

Antes de reservar, se ejecutan cuatro pruebas de reservas sin red, se construye la
imagen, se ejecutan las ocho pruebas del ensayo con modelo simulado y se validan
los parámetros reales sin red. Estos pasos y los tres ciclos reales pasaron en
la ejecución enlazada arriba.

Este ensayo no prueba operación de 24 horas, permanencia del disco entre máquinas,
investigación comercial autónoma ni rentabilidad. Solo prueba la continuidad de
tres turnos reales con reinicios controlados y una misión sintética conocida.
