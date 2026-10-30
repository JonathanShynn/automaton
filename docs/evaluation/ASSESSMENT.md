# Resultado de la evaluación inicial

Registro histórico del código original. Las correcciones y los resultados
posteriores están en [HARDENING.md](HARDENING.md).

Fecha: 29 de octubre de 2026, Asia/Taipei.
Versión analizada: Automaton 0.2.1, commit upstream
`d8f816881fd24b6f5e3d616e59edec387a447667`.

**Decisión: continuar la evaluación aislada; no adoptar todavía el arranque
normal como sistema productivo ni habilitar operaciones económicas.** El motor
ya ofrece componentes reutilizables. Las pruebas realizadas no demuestran
rentabilidad comercial ni autonomía confiable durante horas o días.

## Evidencia obtenida

| Comprobación | Resultado |
| --- | --- |
| Instalación con pnpm 10.28.1 y Node 22 | Dependencias y módulo SQLite instalados |
| TypeScript del proyecto y de la evaluación | Correcto |
| Construcción del motor y CLI | Correcta |
| Ocho archivos de pruebas del núcleo | 390 pruebas correctas |
| Integración de evaluación propia | 4 pruebas correctas |
| Ejecución en contenedor en GitHub Actions | Construcción correcta y 4 pruebas correctas, con red deshabilitada y aplicación en solo lectura |
| Memoria persistente | SQLite real, lectura desde otro proceso y continuación verificadas |
| Tarea programada pendiente | Recuperada tras cerrar y reabrir la base, sin duplicar el primer trabajo completado |
| Acciones externas de la evaluación | Lista restrictiva de herramientas y cliente simulado que falla al recibir operaciones prohibidas |
| Red del proceso de evaluación | Creación de sockets IPv4/IPv6 denegada también en proceso hijo |
| Suite completa upstream | No terminó dentro de 240 segundos; salida 124, no aprobada |
| Auditoría de dependencias de producción | No limpia: metadata de pnpm informa 2 críticas, 10 altas y 9 moderadas |

Los resultados estructurados se conservan en [results.json](results.json).
La receta ejecutable y su alcance están en [README.md](README.md).
La [ejecución aprobada en GitHub](https://github.com/JonathanShynn/automaton/actions/runs/40733499208)
corresponde al commit `933421755021b0b1232cdf21fb84db5a4fdf40c6`.
Las 4 pruebas del contenedor terminaron en 2,07 segundos. La primera ejecución
detectó que Vite quería escribir su configuración temporal junto al código en
solo lectura; se corrigió trasladando esa configuración a `/tmp`, sin relajar
el aislamiento. La segunda ejecución finalizó correctamente.

Las 390 pruebas pertenecen a base de datos, transacciones, memoria, políticas
financieras, motor de políticas, inyección de comandos, defensa de entradas y
planificador. No representan toda la batería del proyecto.

La misión comercial es deliberadamente ficticia: tres ventas supuestas de
USD 49, coste variable supuesto de USD 9 y coste fijo supuesto de USD 20 producen
USD 100 hipotéticos. Se guarda `actualRevenueUsd: 0` y `marketValidated: false`.
La respuesta del modelo está predefinida; no se está midiendo la capacidad de
un modelo para descubrir un negocio. No se hicieron pagos ni se configuró una
cuenta de servicios de Automaton.

## Hallazgos que impiden recomendar producción

1. **Alertas de dependencias.** `pnpm audit --prod --json` devolvió código 1.
   Entre los paquetes señalados están `simple-git`, `yaml`, `ws`, `js-yaml`,
   `uuid` y `stream-json`. La lista tiene 18 avisos distintos; los 21 hallazgos
   de metadata incluyen rutas de dependencias, no 21 paquetes diferentes.
   [dependency-audit.json](dependency-audit.json) conserva identificadores,
   severidades y versiones parcheadas indicadas por el registro. No se ha
   demostrado explotación en esta aplicación ni se han actualizado paquetes
   mayores sin validar su compatibilidad.
2. **El presupuesto predeterminado excede una prueba pequeña.**
   `src/types.ts` configura transferencias de hasta USD 50 por operación,
   USD 100 por hora y USD 250 por día; el límite diario declarado de inferencia
   es USD 500. Los presupuestos horario, de sesión y por llamada del modelo
   tienen `0` como valor predeterminado, interpretado como ausencia de límite
   en `src/inference/budget.ts`. No existe aquí una demostración de un tope
   global que cubra todos los servicios y rutas del runtime.
3. **Existen recargas automáticas fuera de una decisión del modelo.**
   `src/index.ts` llama a `bootstrapTopup` en el arranque. `src/agent/loop.ts`
   contiene recargas ante crédito bajo y ante errores de creación de sandbox.
   Por eso una instrucción de texto que diga «no gastar» no basta para impedir
   movimientos si se entrega una billetera financiada. Estas rutas no se
   ejecutaron en nuestra evaluación.
4. **El límite de hijos requiere corregirse/verificarse.** En
   `src/replication/spawn.ts`, `spawnChild` lee `(db as any).config?.maxChildren`
   y usa 3 como alternativa. El objeto de base creado por `createDatabase`
   no recibe esa configuración en el arranque revisado. Es una observación
   estática: no se ha creado ningún agente hijo para demostrarla. Establecer
   `config.maxChildren = 0` por sí solo no es una protección demostrada.
5. **Los indicadores de CI upstream no bastan como aprobación.** El workflow
   heredado convierte el timeout de los tests en éxito y ejecuta la auditoría
   con `|| true`. Además, los comandos de seguridad usan `--grep`; se reprodujo
   `CACError: Unknown option --grep` con Vitest 2.1.9. Nuestro workflow
   de evaluación propaga el fallo o timeout del contenedor.

## Encaje con Gemini y Supabase

Automaton usa TypeScript y SQLite con un esquema propio. No se encontró un
adaptador Supabase en el código revisado. Cambiar una URL no migra el estado:
haría falta un adaptador o una sincronización explícita, con pruebas de
consistencia y recuperación. Una primera integración puede conservar SQLite
para el runtime y exportar únicamente eventos o resultados comerciales.

El README de upstream menciona Gemini a través de la inferencia de Conway.
Eso no demuestra compatibilidad directa con una clave o integración existente
de Gemini. No se probó ninguna llamada real a Gemini ni se usaron credenciales
de otro proyecto. El trabajo previo permanece separado.

## Condiciones concretas para la siguiente fase

- Resolver las alertas críticas y altas relevantes y volver a ejecutar sus
  pruebas de compatibilidad, sin ocultar fallos de auditoría.
- Completar una batería de pruebas acotada y reproducible que termine por sí
  sola; un timeout no debe figurar como aprobación.
- Implementar un arranque propio con permisos restrictivos en todas las rutas,
  incluida recarga automática, workers, shell y registro externo. El perfil
  dentro de nuestro test **no cambia el arranque normal**.
- Verificar un presupuesto global y un mecanismo de parada independientes de
  las instrucciones del modelo.
- Elegir e integrar un proveedor de inferencia y un servidor persistente
  dentro del presupuesto autorizado; no se contrató ninguno en esta fase.
- Ejecutar una prueba prolongada real de recuperación y una misión comercial
  con evidencia de demanda antes de atribuir resultados económicos al agente.

Hasta entonces, el resultado entregado es una evaluación finita y reproducible.
No se dejó un servicio productivo ejecutándose ni una tarea recurrente que
consuma indefinidamente.
