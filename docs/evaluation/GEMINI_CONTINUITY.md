# Tres ciclos reales de continuidad con Gemini

Fecha: 30 de octubre de 2026 (Taiwán).

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
prompts, respuestas ni registros completos como artefactos.

Antes de reservar, se ejecutan cuatro pruebas de reservas sin red, se construye la
imagen, se ejecutan las ocho pruebas del ensayo con modelo simulado y se validan
los parámetros reales sin red. Los resultados del ensayo real se incorporarán
aquí una vez que termine; preparar esta receta no demuestra su ejecución.

Este ensayo no prueba operación de 24 horas, permanencia del disco entre máquinas,
investigación comercial autónoma ni rentabilidad. Solo prueba la continuidad de
tres turnos reales con reinicios controlados y una misión sintética conocida.
