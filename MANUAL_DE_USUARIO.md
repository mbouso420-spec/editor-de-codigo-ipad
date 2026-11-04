# Manual de Usuario — Studio IDE

Esta guía reúne todo lo que necesitás para instalar **Studio IDE** en tu iPad, aprovechar la interfaz en PC o *Stage Manager*, conectar modelos de inteligencia artificial gratuitos y sincronizar tus proyectos con **GitHub**.

---

## Índice

1. [Activar GitHub Pages e instalar la app en el iPad (PWA)](#1-activar-github-pages-e-instalar-la-app-en-el-ipad-pwa)
2. [Recorrido por la interfaz y atajos rápidos](#2-recorrido-por-la-interfaz-y-atajos-rápidos)
3. [Gestión de proyectos, archivos y guardado automático](#3-gestión-de-proyectos-archivos-y-guardado-automático)
4. [Vista previa en vivo y Consola (Web + Python 3)](#4-vista-previa-en-vivo-y-consola-web--python-3)
5. [Configurar el Asistente de IA gratuito (y pasar claves al iPad)](#5-configurar-el-asistente-de-ia-gratuito-y-pasar-claves-al-ipad)
6. [Trabajar con el Asistente IA sobre tu código](#6-trabajar-con-el-asistente-ia-sobre-tu-código)
7. [Cómo conectar GitHub y hacer Commit y Push paso a paso](#7-cómo-conectar-github-y-hacer-commit-y-push-paso-a-paso)

---

## 1. Activar GitHub Pages e instalar la app en el iPad (PWA)

### Paso A: Activar el link web gratuito en GitHub (una sola vez)
1. Entrá a tu repositorio en GitHub: `https://github.com/mbouso420-spec/editor-de-codigo-ipad`
2. Tocá la pestaña **Settings** (arriba) y en el menú lateral izquierdo entrá a **Pages**.
3. En **Build and deployment** -> **Source**, dejá elegido **Deploy from a branch**.
4. En **Branch**, seleccioná **`main`** y carpeta **`/ (root)`**, y tocá **Save**.
5. Esperá entre 1 y 2 minutos: arriba te va a aparecer tu dirección pública lista:
   `https://mbouso420-spec.github.io/editor-de-codigo-ipad/`

### Paso B: Instalarla a pantalla completa en tu iPad
1. Abrí **Safari** en tu iPad y entrá a `https://mbouso420-spec.github.io/editor-de-codigo-ipad/`.
2. Tocá el botón **Compartir** (el cuadrado con la flecha hacia arriba en la barra de Safari).
3. Elegí **Agregar a inicio** (*Add to Home Screen*) y tocá **Agregar**.
4. Listo: ahora tenés el icono azul de **Studio IDE** en tu pantalla de inicio. Al abrirlo desde ahí corre **a pantalla completa sin barras de Safari** y es 100% compatible con el cambio de tamaño de ventanas en **Stage Manager**.

---

## 2. Recorrido por la interfaz y atajos rápidos

La pantalla está dividida en **3 islas independientes**:

* **Izquierda (`Explorador`):** tus proyectos, carpetas y archivos.
* **Centro (`Editor`):** pestañas abiertas, herramientas táctiles (`Deshacer`, `Rehacer`, `Buscar`, `Ajuste de línea`, `- / +` tamaño de letra), área de código y la **barra inferior de símbolos rápidos** pensada para el teclado táctil del iPad.
* **Derecha (`Asistente`):** chat con IA conectado en vivo a lo que estás editando.

### Redimensionar y ocultar paneles
* **En pantalla ancha (PC o iPad horizontal amplio):** arrastrá las líneas divisorias entre los paneles para darles el ancho que quieras, o tocá **Explorador** / **Asistente** arriba para ocultarlos y dejar el código a pantalla completa.
* **En ventana mediana de Stage Manager o iPad vertical:** los paneles laterales pasan automáticamente a modo cajón flotante (*drawer*). Podés cerrarlos tocando afuera o deslizando el dedo hacia el borde.
* **Barra de símbolos:** tocá el botón **Símbolos** en la barra superior si usás un teclado físico en el iPad o la PC y querés ganar más renglones de código.

### Atajos de teclado físico (PC o Magic Keyboard en iPad)
| Atajo | Acción |
| :--- | :--- |
| `Ctrl + S` / `Cmd + S` | Fuerza el guardado inmediato en `IndexedDB` sin abrir el cartel del navegador |
| `Ctrl + B` / `Cmd + B` | Muestra u oculta el panel **Explorador** (izquierda) |
| `Ctrl + J` / `Cmd + J` | Muestra u oculta el panel **Asistente IA** (derecha) |
| `Ctrl + F` / `Cmd + F` | Abre el buscador y reemplazador dentro del archivo activo |
| `Ctrl + Z` / `Cmd + Z` | Deshacer cambio en el archivo actual |
| `Ctrl + Espacio` | Fuerza la apertura manual del menú de autocompletado |
| `Enter` (en el chat IA) | Envía tu consulta (`Shift + Enter` hace salto de línea) |
| `Escape` | Cierra ventanas abiertas o paneles flotantes |

---

## 3. Gestión de proyectos, archivos y guardado automático

Todo lo que escribís se guarda solo cada pocos milisegundos en la base de datos interna del navegador (**`IndexedDB`**), incluso si te quedás sin Wi-Fi.

* **Crear archivo o carpeta:** tocá el icono **`+`** (nuevo archivo) o **carpeta con `+`** arriba en el Explorador.
  * *Tip:* si tenés seleccionada una carpeta del árbol, el archivo se crea adentro de esa carpeta; también podés escribir rutas directas como `src/utilidades/calculo.cpp`.
* **Renombrar o borrar:** en cada fila del árbol tenés el icono del **lápiz** (renombrar conservando el historial de *Undo/Redo*) y el **cesto** (pide confirmación con un segundo toque antes de borrar).
* **Nuevo proyecto local:** tocá el botón de **capas** al lado del selector de proyectos. Los proyectos locales viven únicamente en ese dispositivo.
* **Importar / Descargar archivos sueltos:** usá la **flecha hacia arriba** para cargar archivos desde la app *Archivos* del iPad o tu PC, y la **flecha hacia abajo** para descargar a tu dispositivo el archivo que tengas abierto.

---

## 4. Vista previa en vivo y Consola (Web + Python 3)

El botón **Vista previa** (arriba a la derecha) funciona **según la pestaña en la que estás parado**:

1. **Si estás en una pestaña `.html`:** muestra **Vista previa de HTML** y une automáticamente los archivos `.css` y `.js` que estén en **esa misma carpeta** para que veas tu sitio completo funcionando.
2. **Si estás en una pestaña `.js`:** muestra **Vista previa de JS** y ejecuta tu código mostrando los resultados en pantalla y en la **Consola JS** de abajo.
   * Si en esa misma carpeta también tenés un `.html` (por ejemplo `index.html` + `app.js`), arriba te aparece un botón para alternar con un clic entre **Ver junto a index.html** o **Ejecutar solo este .js**.
3. **Si estás en una pestaña `.py` (Python):** muestra **Vista previa de Python**, carga el motor **Python 3 (WebAssembly / Pyodide)** directamente en tu iPad o PC (solo tarda unos segundos la primera vez y luego queda en caché) y ejecuta tu código con soporte para `print(...)`, `input("...")`, trazas de error claras e `import` de otros `.py` de esa misma carpeta.
4. **Si estás en una pestaña `.css`:** muestra **Vista previa de CSS** aplicándolo sobre el `.html` que esté en su misma carpeta.
5. **Si estás en `.c`, `.cpp`, `.sql`, etc.:** te avisa claramente que la vista previa en vivo no está disponible para esa extensión.

---

## 5. Configurar el Asistente de IA gratuito (y pasar claves al iPad)

En el panel derecho (**Asistente**), tocá el icono del **engranaje** (o el cartel **Falta clave**). Tenés 4 proveedores gratuitos listos para usar:

### ¿Cuál conviene elegir?
1. **Groq (Gratis — Ultrarrápido)** *(Recomendado principal)*
   * Creá tu clave gratis sin tarjeta en: `https://console.groq.com/keys`
   * Modelo recomendado: **`GPT-OSS 120B`** (`openai/gpt-oss-120b`). Es rapidísimo y excelente en lógica, C/C++, JS y SQL.
2. **Google Gemini (Gratis — AI Studio)**
   * Creá tu clave gratis en: `https://aistudio.google.com/apikey`
   * Si en hora pico un modelo tiene alta demanda, el IDE prueba automáticamente otro modelo gratuito disponible de tu cuenta.
3. **OpenRouter (Modelos `:free`)**
   * Creá tu clave en: `https://openrouter.ai/keys`
   * El selector `openrouter/free` enruta automáticamente hacia los mejores modelos gratuitos activos.
4. **Mistral (Gratis — La Plateforme)**
   * Creá tu clave en: `https://console.mistral.ai/api-keys` (incluye *Codestral* especializado en código).

### Cómo pasar todas tus claves de la PC al iPad sin copiarlas una por una
Como por seguridad tus claves no se suben a internet, tenés un botón especial adentro del engranaje del Asistente:
1. En tu PC (donde ya cargaste tus API Keys y tu token de GitHub), tocá **Copiar pack de claves**.
2. Mandátelo a vos mismo al iPad (por AirDrop, Notas de iCloud, WhatsApp o mail).
3. En el iPad, abrí el engranaje del Asistente, tocá **Importar pack**, pegá el texto y tocá **Guardar**. Se configuran todas las IA y GitHub de una sola vez.

### Privacidad en equipos compartidos
* **Este dispositivo:** recuerda tus claves aunque cierres Safari o apagues el iPad.
* **Solo esta sesión:** borra automáticamente todas las claves apenas cerrás la pestaña (ideal si algún día abrís tu IDE en una PC prestada o de la facultad).

---

## 6. Trabajar con el Asistente IA sobre tu código

* **Lectura automática:** no hace falta que copies y pegues tu archivo en el chat; el Asistente lee siempre el **archivo activo** que tenés abierto en el centro.
* **Consultar sobre unas líneas puntuales:** seleccioná con el dedo o el mouse una función o bloque de renglones. Arriba del chat vas a ver *"X líneas seleccionadas"* para que la IA se enfoque ahí.
* **Sumar otras pestañas como referencia:** si tenés varios archivos abiertos (por ejemplo `index.html` y `app.js`), debajo de la barra de contexto aparecen botones `+ app.js`. Tocalos para que la IA lea ambos archivos a la vez.
* **Botones en cada bloque de código que te responde la IA:**
  * **En cursor:** pega ese código justo donde dejaste el cursor en el editor.
  * **Reemplazar sel.:** cambia únicamente el fragmento que tenías pintado/seleccionado.
  * **Aplicar archivo:** antes de tocar tu archivo, te abre el **Visor de Diferencias (Diff)** mostrándote en **verde** las líneas nuevas y en **rojo** las que se quitan. Recién se aplica si tocás **Confirmar y aplicar**.
  * **Copiar:** copia el bloque al portapapeles.

---

## 7. Cómo conectar GitHub y hacer Commit y Push paso a paso

Usá un repositorio de GitHub cada vez que quieras **respaldar un proyecto en la nube** o **empezar a programar en la PC y seguir en el iPad** (o viceversa).

### Paso 1: Crear tu llave de permiso en GitHub (solo la primera vez)
1. Entrá a **GitHub.com** -> tocá tu **foto de perfil** (arriba a la derecha) -> **Settings**.
2. Bajá hasta el final del menú izquierdo -> **Developer settings** -> **Personal access tokens** -> **Fine-grained tokens** -> **Generate new token**.
3. Completá:
   * **Token name:** `Studio IDE`
   * **Repository access:** marcá **All repositories**
   * **Permissions:** desplegá **Repository permissions**, buscá **Contents** y elegí **Read and write** *(obligatorio para poder subir commits)*.
4. Tocá **Generate token** y copiá el código que empieza con `github_pat_...`.

### Paso 2: Elegir tu repositorio directo en el Explorador (sin necesidad de descargarlo)
1. Si todavía no conectaste tu cuenta, tocá una sola vez el botón azul **Repositorio** arriba a la derecha, pegá tu token `github_pat_...` y tocá **Conectar** (aparecerá tu `@usuario` en verde).
2. A partir de ese momento, andá directamente al **menú desplegable arriba a la izquierda en el Explorador**: vas a ver dos secciones:
   * **`En este iPad`:** tus proyectos locales.
   * **`Mis repos de GitHub`:** todos los repositorios de tu cuenta listos para elegir con un toque.
3. Elegí el repositorio que quieras usar: el árbol completo de carpetas y archivos aparece **al instante sin descargar todo el repositorio**, y cada archivo se abre bajo demanda recién cuando lo tocás (y queda guardado en caché en tu iPad).
4. **¿Querés tenerlo completo para trabajar sin internet?** Tocá el **icono de la nube con flecha** en la barra del Explorador (*Guardar copia offline en el iPad*) o el botón **Guardar copia offline** dentro de **Repositorio**. Cuando termina, el icono se pone en verde y el proyecto muestra la etiqueta **`[Offline]`**.

### Paso 3: Subir tus avances a GitHub (`Commit y Push`)
1. Mientras editás, creás o borrás archivos, todo se autoguarda localmente en tu dispositivo y el botón superior pasa a mostrar cuántos archivos cambiaron: **`Commit (1)`**, **`Commit (2)`**, etc.
2. Cuando termines una parte y quieras subirla a GitHub, tocá ese botón **`Commit (X)`**.
3. En **3. Cambios locales listos para Commit**:
   * Podés tocar **Diff** al lado de cada archivo para revisar en verde y rojo qué modificaste.
   * Escribí un **Mensaje del commit** breve (ej. `Agregué validación al formulario`).
   * Tocá **Commit y Push a GitHub**.
4. Cuando veas el aviso verde **`Commit ... publicado en main`**, tus cambios ya están guardados en GitHub.

### Paso 4: Traer cambios cuando cambiás entre PC e iPad (`Actualizar remoto`)
* Si hiciste un *Commit y Push* desde tu PC y más tarde agarrás el iPad, abrí el botón **Repositorio** en el iPad y tocá **Actualizar remoto** antes de empezar a editar para asegurarte de tener la última versión descargada.
  *(Si tenías ediciones locales sin subir en el iPad, el botón te va a pedir un segundo toque de confirmación para no pisar tu trabajo por accidente).*
