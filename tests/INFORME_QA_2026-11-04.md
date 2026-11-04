# Informe de QA extremo — Studio IDE (2026-11-04)

Base auditada: commit `39c729e` (HEAD de `main`, ya publicado en `origin/main`).
Cambios de esta auditoría: **sin commitear** en la copia de trabajo.

## A. Resumen ejecutivo

- **Estado al inicio: la app publicada no arrancaba.** Todas las cargas lanzaban `ReferenceError: updateProjectDeleteBtn is not defined` (BUG-23), introducido por el commit anterior de QA. El editor quedaba vacío y el arranque se cortaba.
- Se encontraron, reprodujeron con tests en rojo, corrigieron y verificaron en verde **9 defectos** (BUG-16, 16b, 17, 18, 19, 20, 21, 22, 23): 1 crítico, 4 altos, 3 medios y 1 bajo/medio.
- Cobertura nueva: suite automatizada de **160 pruebas** (`tests/`, `node --test`) con fuzzing, pruebas basadas en propiedades y en modelo, y una guarda de análisis estático. Además, **14 escenarios E2E** en un navegador real.
- Riesgos pendientes: flujos reales contra GitHub y proveedores de IA (requieren credenciales), comportamiento en iPad real y bucles infinitos en la vista previa (ver J).

## B. Inspección inicial

- **Tecnologías:** HTML5 + CSS (tokens oklch) + ES Modules nativos sin build; CodeMirror 6 y Octokit desde `esm.sh` vía importmap; Pyodide 0.27.3 desde jsDelivr; IndexedDB; Service Worker; GitHub REST v3; APIs de Gemini, Groq, OpenRouter y Mistral.
- **Archivos analizados (31 en el repo):** los 14 módulos JS (~8 000 líneas), `sw.js`, `index.html` (importmap e IDs), `manifest.json` y los CSS (solo revisión de referencias).
- **Problemas iniciales:** no había ninguna prueba automatizada. Las funciones puras no se exportaban, así que no se podían probar. La rama publicada estaba rota (BUG-23).
- **Verificación estructural:** sintaxis de todos los módulos (`node --check`), JSON del importmap y del manifiesto, sin IDs duplicados en el HTML, y todos los `getElementById` del JS existen (salvo los de las plantillas de iframe, como corresponde).

## C. Estadísticas de testing

| Concepto | Cantidad |
|---|---|
| Pruebas automatizadas diseñadas (suite final) | 160 |
| Ejecutadas en la corrida final | 160 |
| Aprobadas en la corrida final | 160 |
| Fallidas en la corrida final | 0 |
| Corrida de línea base (antes de corregir) | 154 diseñadas: 145 aprobadas, 9 fallidas (8 por defectos reales y 1 por un error del oráculo de la prueba, corregido) |
| Corridas completas de regresión | 5 (la final más 3 repeticiones anti-flakiness, todas 160/160; y una previa a E2E con 159/159) |
| Escenarios E2E en navegador real | 14 ejecutados (1 falló → BUG-23 → corregido y re-ejecutado) |
| E2E no ejecutados | 2 de UI (borrar proyecto y Buscador rápido, por cierre del panel del navegador) más los flujos que requieren credenciales (ver G) |
| Iteraciones del ciclo detectar → corregir → re-verificar | 7 |
| Volumen de fuzzing | 2 000 rutas aleatorias, 1 500 operaciones de archivo contra un modelo, 3 000 cadenas XSS y 412 diffs (400 chicos + 12 grandes) |

## D. Registro de errores

| ID | Archivo | Descripción | Gravedad | Prob. | Causa raíz | Solución | Verificación |
|---|---|---|---|---|---|---|---|
| BUG-23 | `js/ui/explorerController.js:241` | La app no arranca: `ReferenceError` en cada carga | **Crítica** | 100 % | Llamada a `updateProjectDeleteBtn` (no existe); la función real es `syncProjectDeleteButton` | Se corrigió la llamada | E2E: el arranque carga el editor, las pestañas y el contenido. Guarda `lint.test.js` con prueba de mutación: detecta el error reintroducido |
| BUG-16 | `workspaceDb.js` `markProjectSynced` | Lo editado/creado/borrado **mientras viaja un push** se marcaba como sincronizado y nunca se subía | Alta | Media (autoguardado a 240 ms frente a push de segundos) | Tras el push se consolidaba el estado *actual*, no lo enviado | Se consolida solo la instantánea enviada (`changes`); el controlador la pasa | 4 tests en rojo → verde |
| BUG-16b | ídem | Archivo nuevo borrado o renombrado durante su push: GitHub lo tiene, localmente no figuraba ningún borrado pendiente | Media | Baja | Los archivos no trackeados se borran físicamente | Se crea un registro de borrado pendiente | Test en rojo → verde |
| BUG-17 | `workspaceDb.js` hidratación | Abrir/actualizar un repo de 3 000 archivos tardaba **32,3 s**, y no era atómico (si se interrumpía, el proyecto quedaba a medio borrar) | Alta | Alta en repos medianos | `upsertEntry` por archivo, cada uno leyendo todo el proyecto: O(n²) | Una única transacción de IndexedDB, O(n) | 32 349 ms → **54–58 ms**; fuzz en verde |
| BUG-18 | `js/ui/diffModal.js` | En archivos grandes, 2 líneas cambiadas se mostraban como **+1500 / −1500** | Media | Alta en archivos de ~1 000+ líneas | Fallback de “todo borrado / todo agregado” | Diff de Myers (mínimo) con presupuesto de cómputo; el fallback solo aplica a la zona central | Fuzz de propiedad contra un LCS independiente; 5 000 líneas en 43 ms |
| BUG-19 | `js/app.js` (4 puntos) + `cacheSingleGithubFileContent` | Si cambiabas de proyecto mientras bajaba un archivo, su contenido se guardaba **en el otro proyecto** (podía pisar ediciones locales). Lo mismo pasaba al renombrar y con la copia offline | Alta | Baja | Se usaba `activeProject.id` después del `await` | Se fija el proyecto antes de esperar y se aborta si cambió; la caché nunca pisa contenido local | Test de datos en rojo → verde. La parte de UI se verificó estáticamente |
| BUG-20 | `githubService.js`, `workspaceDb.js` | El push convertía scripts `100755` en `100644`, y los symlinks editados en archivos comunes | Baja/Media | Media en repos con scripts | Modo fijo `100644` | Se conserva el modo de punta a punta y se excluyen los symlinks | 2 tests en rojo → verde |
| BUG-21 | `js/ai/providers.js` | Un fallo a mitad del streaming reintentaba con otro modelo y **duplicaba el texto ×3** | Media | Baja/Media | El fallback no sabía que ya se había emitido texto | No se reintenta si ya hubo salida | Test en rojo (`'parcialparcialparcial'`) → verde |
| BUG-22 | `js/ai/providers.js` | **La clave de Gemini viajaba en la URL** (`?key=`), expuesta en logs, historiales y proxies | Media (seguridad) | Alta | Diseño | Se envía en la cabecera `x-goog-api-key` | Test en rojo → verde. No verificado contra la API real |

## E. Pruebas aprobadas (qué y cómo)

- **Persistencia:** particiones de equivalencia y valores límite de rutas, con fuzz de 2 000 rutas (idempotencia, sin `..` ni `//`). Validación de nombres (15 rechazos, 7 aceptaciones). Tabla de decisión de 19 extensiones. CRUD, conflictos archivo/carpeta, prefijos parecidos (`src` frente a `src2`), Unicode y 1 MB. **Fuzz basado en modelo:** 1 500 operaciones aleatorias comparadas paso a paso contra un `Map` de referencia (archivos y carpetas).
- **Cambios Git:** alta, modificación y borrado; revertir una edición; renombrar ida y vuelta; recrear sobre un archivo lazy; reutilización por SHA; las condiciones de carrera durante el push.
- **Diff:** reconstrucción exacta de ambas versiones, y mínimo frente a un LCS de referencia **independiente** (DP clásica, no la del código bajo prueba).
- **Seguridad:** 11 payloads XSS y 3 000 cadenas aleatorias contra ambos renderizadores Markdown (solo etiquetas y atributos de una lista blanca; `href` solo `https?:`/`#`). `</script>` y `</style>` en recursos incrustados. Carga útil de Python intacta y sin poder escaparse. **En navegador real:** el sandbox de la vista previa bloquea `parent.document`, `localStorage` (donde está el PAT), cookies, IndexedDB y la navegación del `top`.
- **GitHub (fetch simulado):** filtros del árbol, ramas con `/`, repo vacío, 401, base64 UTF-8, descargas por lotes, commit atómico, `RemoteAheadError` sin escrituras, `force`, inicialización de repo vacío.
- **IA (fetch simulado):** SSE partido cada 7 bytes (corta caracteres multibyte), CRLF, comentarios y `[DONE]`; 401 sin reintento; fallback ante 429; bóveda de claves (importar/exportar, aliases, migración entre sesión y local).
- **E2E (navegador real):** arranque; autoguardado en IndexedDB y persistencia tras recargar (ñ y emoji); rechazo de `../fuera.js` y de duplicados; creación anidada con Unicode; Python + `input()` (`len("Ana ñ 😀") = 7`, correcto); vista previa HTML con CSS incrustado y puente de consola; renombrar hacia una subcarpeta nueva (pestaña y activo se actualizan, contenido íntegro); borrar en dos pasos (el primer clic no borra; la confirmación expira); borrar carpeta cierra sus pestañas; proyecto con nombre `<b>` (se escapa) y aislamiento entre proyectos.

## F. Pruebas fallidas

En la corrida final no hay ninguna. Todas las fallas históricas están en D. Una de ellas fue un defecto **del oráculo del fuzz** (no modelaba las carpetas vacías, que la app conserva a propósito): se corrigió la prueba, no la app, y el fuzz ahora además verifica carpetas.

## G. Pruebas pendientes o imposibles

- **Push, pull y conflictos reales contra GitHub** (incluida la codificación `%2F` de la Contents API al inicializar un repo vacío): requieren un PAT y un repo de prueba. Solo se verificaron con un servidor simulado.
- **Proveedores de IA reales** (incluida la cabecera `x-goog-api-key` de Gemini): requieren claves.
- **iPad real:** táctil, `visualViewport`, Stage Manager, instalación PWA, Service Worker offline (en localhost el SW se desregistra a propósito).
- **Desde la UI:** borrar proyecto y Buscador rápido (Ctrl+P). Se cerró el panel del navegador; la capa de datos está cubierta por tests.
- **Clics y teclas dentro del iframe de origen opaco:** la herramienta no los entrega. Se resolvió cargando el mismo `srcdoc` en un iframe del mismo origen.

## H. Cambios realizados

- `js/ui/explorerController.js`: BUG-23; `export` de `buildHierarchy` y `flattenVisibleTree`.
- `js/storage/workspaceDb.js`: BUG-16, 16b, 17, 19 (guard de caché), 20.
- `js/github/githubService.js`: BUG-20. `js/github/githubController.js`: le pasa la instantánea a `markProjectSynced` (BUG-16).
- `js/app.js`: BUG-19 en `ensureFileContentLoaded`, `ensureFilesLoaded`, renombrar y copia offline.
- `js/ai/providers.js`: BUG-21 y BUG-22.
- `js/ui/diffModal.js`: BUG-18 (Myers) y `export` de `computeLineDiff`.
- `js/ui/livePreviewModal.js`, `js/ai/chatController.js`: solo se agregó `export` a funciones puras, para poder probarlas.
- `sw.js`: caché `v13` → `v14`, para que las PWA instaladas recarguen la versión corregida.
- `tests/` (nuevo): `package.json`, `setup.js`, 5 archivos `*.test.js` y este informe. `.claude/launch.json` (nuevo, sin trackear): servidor local de pruebas.

## I. Regresión

Tras cada corrección se re-ejecutó la suite completa: 156 → 158 → 159 → 160 pruebas, todas en verde. La corrida final más 3 repeticiones dieron 160/160 sin flakiness. Se repasaron sintaxis y `no-undef` de todo el código. El fuzz basado en modelo reverificó que la hidratación nueva no rompió el CRUD.

## J. Riesgos residuales

1. **Un bucle infinito en la vista previa** (JS o Python) puede congelar la pestaña del IDE (Pyodide corre en el hilo del iframe). No se ejecutó para no colgar el entorno. Se recomienda mover Pyodide a un Web Worker con timeout.
2. Python con `input()` **re-ejecuta el script completo** por cada entrada; el código con efectos o que depende de la hora puede comportarse distinto.
3. Para árboles de GitHub truncados (repos enormes) no se avisa al usuario; los archivos faltan en silencio.
4. Las claves y el PAT se guardan en `localStorage` en texto plano (por diseño). Los módulos de CDN (esm.sh, jsDelivr) no tienen SRI: se confía en esos CDN.
5. Los errores de OpenRouter que llegan dentro del stream se ignoran (respuesta vacía, sin mensaje).
6. Durante la carga, el iframe de vista previa se vio en blanco en el navegador embebido; no se determinó si pasa también en Safari.

## K. Veredicto

**APROBADO CON OBSERVACIONES.** No quedan fallos críticos ni altos conocidos sin corregir en el alcance verificable, y todas las correcciones tienen una prueba que antes fallaba. Quedan las limitaciones de G y J. **Importante:** la versión publicada sigue rota hasta que estos cambios se commiteen y se publiquen.
