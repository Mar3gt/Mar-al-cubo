# Así quedaría

Página web para ver cómo quedaría una habitación real decorada con **tus propios muebles**, tus fotos de inspiración y tus instrucciones.

1. **Mi habitación**: foto principal (la base que se edita) y otros ángulos opcionales.
2. **Mis muebles y objetos**: fotos con nombre («mi sofá», «la lámpara negra»), estado *Usar / Probar en una variante / Dejar fuera* y medidas opcionales.
3. **Mi inspiración**: referencias con lo que te gusta de cada una («solo la paleta», «la iluminación»…).
4. **¿Cómo quieres que quede?**: instrucciones libres que nombran tus objetos.

«Ver cómo quedaría» envía en **una sola solicitud** la foto principal, los ángulos, las fotos de los muebles y las referencias a un modelo de edición de imágenes, y devuelve la habitación editada. Si hay objetos marcados como «Probar en una variante», se generan dos versiones: la propuesta y la variante.

En el resultado tienes el deslizador *Antes / Después*, tarjetas de los objetos incluidos (tócalas para moverlos, quitarlos o cambiarlos), el campo «Ajustar esta propuesta» (edita la versión actual), el historial de versiones con comparación lado a lado y la descarga de la imagen.

## Puesta en marcha

Requiere Node.js 18.17 o superior. No hay dependencias que instalar.

```bash
cp .env.example .env     # y pega tu clave
npm start                # http://localhost:3000
```

Servicios admitidos (elige uno en `.env`):

| Variable | Modelo por defecto | Imágenes por solicitud |
| --- | --- | --- |
| `GEMINI_API_KEY` | `gemini-2.5-flash-image` (cámbialo con `GEMINI_IMAGE_MODEL`) | hasta 14 |
| `OPENAI_API_KEY` | `gpt-image-1` (cámbialo con `OPENAI_IMAGE_MODEL`) | hasta 16 |

Sin clave, la página funciona para subir fotos y escribir instrucciones, muestra un aviso y deja el botón de generación desactivado. `npm run demo` activa un modo de prueba que devuelve la foto sin editar, útil para revisar la interfaz.

Para usarla desde el celular, abre `http://<IP-de-tu-computadora>:3000` en la misma red Wi‑Fi.

## Privacidad y almacenamiento

- La clave del servicio solo vive en el servidor; el navegador nunca la ve.
- Las fotos se reducen en el navegador antes de enviarse (máx. 1600 px la principal, 1024 px las demás).
- El proyecto y las versiones se guardan en el navegador (IndexedDB). «Nuevo proyecto» lo borra todo.

## Estructura

```
server.js        servidor HTTP sin dependencias + puente con Gemini / OpenAI
public/
  index.html     estructura de la página
  styles.css     diseño (crema, verde oliva, madera)
  app.js         cargas, generación, ajustes, historial y descarga
```
