# Flix TiviMate Bridge

Genera una lista M3U para TiviMate usando el catálogo TV de Flix-Streams y asigna `tvg-id`/logos a partir de la guía XMLTV de EPG_dobleM.

## Endpoints

- `/playlist.m3u` → playlist para TiviMate
- `/epg.xml` → passthrough del XMLTV configurado
- `/channels.json` → canales resueltos con datos de matching
- `/health` → estado del servicio

## Variables

- `FLIX_BASE_URL` → URL base del addon, sin `/manifest.json`
- `CATALOG_ID` → por defecto `vavoo-country-spain-live`
- `EPG_URL` → XMLTV origen
- `CONCURRENCY` → peticiones paralelas a `/stream`

## Deploy en Render

1. Sube este proyecto a GitHub.
2. Crea un Web Service en Render.
3. Añade `FLIX_BASE_URL` en Environment.
4. Despliega.
5. Usa la URL final `https://tu-servicio.onrender.com/playlist.m3u` en TiviMate.

## Nota

El matching EPG es heurístico. Revisa `/channels.json` para ver `tvgId`, `epgName` y `matchScore` y ajustar reglas si algún canal no coincide bien.
