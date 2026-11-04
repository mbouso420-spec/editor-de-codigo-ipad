# Studio IDE — Editor de Código Web para iPadOS y Escritorio

**Studio IDE** es un entorno de desarrollo web ligero, modular y sin servidores intermedios, diseñado específicamente para programar con fluidez desde un **iPad** (instalado como PWA a pantalla completa en Safari y totalmente adaptable a ventanas de **Stage Manager**) así como desde una **PC de escritorio**.

- **Aplicación web (GitHub Pages):** https://mbouso420-spec.github.io/editor-de-codigo-ipad/
- **Guía paso a paso:** [Ver Manual de Usuario completo (`MANUAL_DE_USUARIO.md`)](./MANUAL_DE_USUARIO.md)

---

## Características principales

### 1. Interfaz de 3 islas pensada para iPadOS y PC
- **Isla izquierda (Explorador):** gestión de múltiples proyectos locales o vinculados a repositorios de GitHub, árbol jerárquico de carpetas y archivos con creación, renombrado y borrado inline (sin ventanas emergentes que bloqueen Safari), además de importación y descarga directa de archivos.
- **Isla central (Editor CodeMirror 6):** soporte para múltiples pestañas, resaltado de sintaxis para **Python, C, C++, HTML, CSS, JavaScript y SQL**, autocompletado inteligente, búsqueda y reemplazo, ajuste de línea (*word wrap*), control de tamaño de fuente e historial independiente de *Undo/Redo* por archivo.
- **Barra táctil contextual de símbolos:** fila inferior con teclas rápidas (`{`, `}`, `(`, `)`, `:`, `def`, `print()`, `;`, `->`, `=>`, `Tab`, etc.) que cambian automáticamente según el lenguaje del archivo activo para escribir código rápido con el teclado en pantalla del iPad.
- **Adaptación a Stage Manager y teclado virtual:** soporte dinámico de `visualViewport` para evitar desplazamientos al abrir el teclado táctil en Safari y paneles laterales que pasan automáticamente a *drawers* deslizables en ventanas medianas o verticales.

### 2. Asistente de IA integrado (100% sobre APIs gratuitas)
- Conecta directamente desde el navegador con niveles gratuitos de **Groq** (`openai/gpt-oss-120b`), **Google Gemini** (`AI Studio`), **OpenRouter** (`openrouter/free`) y **Mistral** (`La Plateforme`), sincronizando en vivo los modelos disponibles de cada cuenta.
- Lee automáticamente el **archivo activo**, las **líneas seleccionadas** en el editor y cualquier **otra pestaña abierta** que adjuntes con un toque.
- Acciones directas en cada bloque de código devuelto por la IA:
  - **En cursor:** inserta el fragmento exactamente donde está posicionado el cursor.
  - **Reemplazar sel.:** sustituye únicamente el bloque resaltado.
  - **Aplicar archivo:** abre primero un **Visor de Diferencias (Diff)** en verde y rojo para revisar línea por línea antes de confirmar el reemplazo.
  - **Copiar:** copia limpia al portapapeles.
- Conserva el historial de conversación por separado para cada proyecto en `IndexedDB`.

### 3. Vista previa en vivo contextual (Web + Python 3) y Consola integrada
- Funciona según la **pestaña activa**:
  - En archivos **`.html`**: ensambla en tiempo real las hojas `.css` y scripts `.js` de su misma carpeta dentro de un `<iframe sandbox>` seguro.
  - En archivos **`.js`**: ejecuta el script mostrando su salida directa en pantalla y en la **Consola JS** integrada (fundamental en iPadOS donde Safari no incluye consola de desarrollador nativa), con opción de alternar junto al `.html` de su misma carpeta.
  - En archivos **`.py` (Python 3)**: ejecuta tus scripts de Python directamente en el navegador mediante **Pyodide (WebAssembly)** sin servidores externos, soportando `print()`, `input()`, manejo claro de errores y `import` entre archivos `.py` de la misma carpeta.
  - En archivos **`.css`**: previsualiza los estilos aplicados sobre el `.html` de su misma carpeta.
  - En lenguajes compilados de escritorio (**`.c`**, **`.cpp`**, **`.sql`**, etc.): informa claramente que la vista previa en vivo no aplica a esa extensión.

### 4. Persistencia offline (`IndexedDB`) y Sincronización con GitHub
- Autoguardado continuo en **`IndexedDB`** con solicitud de almacenamiento persistente (`navigator.storage.persist()`) para proteger tus proyectos en Safari iPadOS incluso trabajando sin conexión.
- Integración directa con la API oficial de **GitHub (`Octokit` / REST v3)**: descarga repositorios completos al iPad, detecta archivos nuevos, editados o eliminados, permite inspeccionar el **Diff** de cada cambio y publica **Commits + Push atómicos** directamente a tu rama.

---

## Arquitectura y estructura del proyecto

Aplicación 100% estática construida con **HTML5 semántico**, **CSS moderno basado en tokens (`oklch`)** y **JavaScript ES Modules nativos**, sin pasos de compilación obligatorios para poder alojarse gratis en GitHub Pages:

```text
.
├── index.html                  # Estructura principal, importmap ESM y diálogos modales
├── manifest.json               # Manifiesto Web App (PWA standalone para iPadOS y escritorio)
├── sw.js                       # Service Worker (Network-First + respaldo offline en caché)
├── .nojekyll                   # Desactiva Jekyll en GitHub Pages para servir módulos directos
├── MANUAL_DE_USUARIO.md        # Manual detallado de instalación, IA gratuita y uso con GitHub
├── assets/
│   ├── icon.svg                # Emblema vectorial de Studio IDE
│   ├── apple-touch-icon.png    # Icono 180x180 para pantalla de inicio en iPadOS
│   └── icon-512.png            # Icono 512x512 para instalación PWA
├── css/
│   ├── tokens.css              # Variables de diseño (colores oklch, espaciado, tipografía)
│   ├── base.css                # Reset accesible y reglas base
│   ├── layout.css              # Layout de 3 islas, resizers táctiles y Stage Manager
│   ├── editor.css              # Pestañas, tema CodeMirror 6 y menú de autocompletado
│   ├── chat.css                # Panel del asistente IA, configuración de claves y Markdown
│   ├── workspace.css           # Árbol de archivos, modal de GitHub, visor Diff y Vista previa
│   └── app.css                 # Punto de entrada de estilos y controles comunes
└── js/
    ├── app.js                  # Orquestador principal de estado, proyectos y atajos globales
    ├── editor/
    │   └── editorManager.js    # Integración con CodeMirror 6 y estados por archivo
    ├── storage/
    │   └── workspaceDb.js      # Capa de persistencia en IndexedDB y cálculo de cambios Git
    ├── ai/
    │   ├── providers.js        # Adaptadores multi-proveedor gratuitos, fallback y bóveda local
    │   └── chatController.js   # Lógica del chat contextual e inyección de código
    ├── github/
    │   ├── githubService.js    # Cliente GitHub API (árboles Git, descarga y commit atómico)
    │   └── githubController.js # Interfaz de conexión PAT, clonado local, Diff y Push
    └── ui/
        ├── layout.js           # Control de paneles, gestos swipe y visualViewport en iPad
        ├── explorerController.js
        ├── symbolBar.js        # Barra rápida de símbolos por lenguaje
        ├── diffModal.js        # Motor LCS y visor de diferencias línea por línea
        ├── livePreviewModal.js # Empaquetador web por carpeta y puente de consola JS
        └── icons.js            # Conjunto de iconos vectoriales SVG (Lucide)
```

---

## Privacidad y seguridad de tus claves

Este repositorio **no contiene ni envía claves a ningún servidor propio**:
- Tus **API Keys de IA** y tu **Personal Access Token de GitHub** se guardan únicamente en el navegador de tu dispositivo (`localStorage` si elegís *Este dispositivo* o `sessionStorage` si elegís *Solo esta sesión*).
- Las peticiones viajan de forma directa desde tu navegador (`HTTPS`) hacia el proveedor oficial correspondiente (`api.groq.com`, `generativelanguage.googleapis.com`, `openrouter.ai`, `api.mistral.ai` o `api.github.com`).

---

## Uso local en PC

Si querés abrir el proyecto localmente en tu computadora antes de subir cambios, serví la carpeta con cualquier servidor estático (necesario para ES Modules):

```bash
# Opción con Python
python -m http.server 8080

# Opción con Node.js
npx serve .
```

Luego abrí `http://localhost:8080` en tu navegador. Para instrucciones completas de instalación en el iPad, configuración de IA gratuita y uso de GitHub, consultá el [**Manual de Usuario (`MANUAL_DE_USUARIO.md`)**](./MANUAL_DE_USUARIO.md).
