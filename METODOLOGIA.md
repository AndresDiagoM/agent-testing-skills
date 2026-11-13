# Metodología para crear y publicar skills

Cada skill pasa por 6 fases. Cada fase termina en una **puerta**: no se pasa a la siguiente sin cumplirla.
La lista para marcar está en `CHECKLIST.md`, dentro de la carpeta de cada skill.

```
1 Diseñar → 2 Probar local → 3 Empaquetar y publicar → 4 Otros agentes → 5 Canales Anthropic (opcional) → 6 Seguridad y mantenimiento
```

## Cómo está organizado este repo

```
skills/                              ← este repo = un marketplace de Claude Code
  .claude-plugin/marketplace.json    ← catálogo: una entrada por skill
  METODOLOGIA.md                     ← esta guía
  _template/                         ← plantilla que copia new-skill.mjs
  scripts/new-skill.mjs              ← crea plugins/<nombre>/ y la registra en el catálogo
  scripts/check-skill.mjs            ← chequeos de portabilidad + claude plugin validate
  plugins/<nombre>/                  ← UNA carpeta por skill (es un plugin con una sola skill)
    .claude-plugin/plugin.json
    skills/<nombre>/SKILL.md         ← la skill (formato estándar agentskills.io)
    skills/<nombre>/scripts|references|assets/
    evals/                           ← casos para claude plugin eval
    README.md  CHANGELOG.md  CHECKLIST.md
```

Crear una skill nueva:

```sh
node scripts/new-skill.mjs mi-skill "Qué hace y cuándo usarla"
```

---

## Fase 1: Diseñar la skill (portable)

**Antes de escribir:**
- Escribe 3 a 5 prompts reales con los que debería activarse, y 2 o 3 parecidos con los que **no** debería. Esos prompts serán los evals de la fase 2.
- Responde: ¿qué sabe la skill que el modelo no sabe solo? Si la respuesta es "nada", no hace falta skill.

**Reglas del `SKILL.md`:**
- `name`: hasta 64 caracteres, solo `a-z`, `0-9` y `-`, sin guiones al inicio, al final ni dobles. **Igual al nombre de la carpeta**. No puede contener `claude` ni `anthropic`.
- `description`: hasta 1024 caracteres, sin etiquetas XML. Primero **qué hace**, después **cuándo usarla** (frases que diría el usuario). Es lo único que el modelo ve antes de decidir si la activa.
- Campos portables (sirven en claude.ai, la API y otros agentes): `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`.
- Campos solo de Claude Code (`disable-model-invocation`, `context`, `hooks`, `model`, `paths`…): **no usarlos** en skills que vayan a claude.ai o la API, porque la subida falla. Si hacen falta, la skill es "solo Claude Code" y se marca así en el README.
- Cuerpo: menos de 500 líneas (~5k tokens). El detalle va a `references/`, a un solo nivel de profundidad, y el cuerpo dice cuándo leer cada archivo.
- Scripts en `scripts/`: deterministas, sin red salvo que sea el propósito, con `--help`.
- Idioma: el `SKILL.md` en inglés para que sirva a más gente; README y notas pueden ir en español.

**Puerta 1:** `node scripts/check-skill.mjs mi-skill` sin errores.

## Fase 2: Probar en local

1. Cargar sin instalar: `claude --plugin-dir ./plugins/mi-skill` (tras cada cambio: `/reload-plugins`).
2. Probar a mano los prompts de la fase 1.
3. Evals (`plugins/mi-skill/evals/`):
   - `trigger-*`: un caso por prompt que debe activarla, con el grader `tool_used: Skill`.
   - `quality-*`: el resultado es correcto (grader `llm`, `regex` o `file_exists`).
   - Casos negativos: un prompt parecido que no debe activarla, con un grader `llm` que lo verifique.
4. Correr una vez: `claude plugin eval ./plugins/mi-skill` (3 corridas por caso y una línea base sin plugin; un caso de activación cuesta unos $0.05 por corrida). Gasta uso real: usa `--case` para repetir solo lo que falló y `--max-cost-usd` como tope.
5. Si no se activa bien, ajusta **solo la `description`** y repite los `trigger-*`.

**Puerta 2:** todos los casos pasan, y el delta con plugin frente a sin plugin es positivo en los de calidad.

## Fase 3: Empaquetar y publicar en nuestro marketplace

1. `plugin.json`: `name` igual al de la skill. **Nunca se renombra** después de publicar.
2. Versión: subir `version` en `plugin.json` en cada release (si no, `claude plugin update` dice que ya está al día). Anotar el cambio en `CHANGELOG.md`.
3. `claude plugin validate ./plugins/mi-skill --strict` y `claude plugin validate . --strict` (el catálogo).
4. Commit y push. Opcional: `claude plugin tag --push` crea el tag `mi-skill--vX.Y.Z`.
5. Instalación para los usuarios (va en el README de la skill):
   ```
   /plugin marketplace add AndresDiagoM/agent-testing-skills
   /plugin install mi-skill@agent-testing-skills
   ```
6. Probar la instalación real desde GitHub en una sesión limpia, no desde la carpeta local.
7. README de la skill: la plantilla ya trae las secciones. Salen de comparar los README de las skills más usadas (superpowers, humanizer, addyosmani/agent-skills, vercel-labs y supabase agent-skills; revisado el 2026-11-12). Orden:
   - badges (skills.sh, licencia, versión);
   - **antes / después** en las primeras ~20 líneas, con un caso real; sin un número de "después" si no se midió;
   - **resultados medidos** de las evals: fecha, modelo, versión del plugin evaluada, y los casos sin ganancia;
   - **Usage** con 4-6 prompts, la invocación (`/mi-skill:mi-skill` si es plugin, `/mi-skill` si es carpeta de skill) y la línea "Not for";
   - **What you get**: salida real recortada, generada corriendo la skill o sus scripts sobre un fixture;
   - problemas que resuelve, comparación con otras skills (con commits), Install, **Updating and uninstalling**, **When something goes wrong**, Tested with, Privacy, Contributing/Changelog, License.

   Reglas: solo números que estén en archivos del repo o de las evals; no enlazar `evals/results/` (está en `.gitignore`); `npx skills` siempre con versión fija; no nombrar proyectos privados.

**Puerta 3:** instalada desde GitHub, aparece como `/mi-skill:mi-skill` y se activa con un prompt de la fase 1.

## Fase 4: Otros agentes (Codex, opencode, Cursor…)

- Si la skill es portable (fase 1), funciona tal cual con el estándar abierto:
  ```
  npx skills@1.7.4 add AndresDiagoM/agent-testing-skills --skill mi-skill
  ```
  (Vercel `skills`, Node 22.20+. Por defecto instala en el proyecto; con `-g`, global.)
- Probar en al menos un agente distinto de Claude Code (por ejemplo opencode o Codex) y anotar en el README en cuáles se probó.

**Puerta 4:** probada en al menos un agente más, y el README lista los agentes probados.

## Fase 5: Canales de Anthropic (opcional, por skill)

| Canal | Cómo | Alcance |
|---|---|---|
| claude.ai | zip de `skills/mi-skill/` → Customize › Skills › Upload | personal; en Enterprise, el owner la puede dar a toda la organización |
| API | `POST /v1/skills` con el zip (< 30 MB) | todo el workspace de la API key |
| Directorio de Anthropic | `claude.ai/directory/manage` (plan de pago, Owner en Team/Enterprise); pasar antes el pre-submission checklist | público en claude.ai, Cowork y Claude Code |

- Antes de enviar al directorio: `claude plugin validate ./plugins/mi-skill --profile directory`. Este perfil exige `license` (ya viene en la plantilla) y recomienda un ícono PNG cuadrado (512–2048 px, < 2 MB) en `.claude-plugin/icon.png`. El ícono se toma **solo la primera vez** que se guarda en el portal. El directorio además hace un escaneo de seguridad y una revisión de políticas que el CLI no hace.
- Los canales **no se sincronizan**: cada subida es una copia que se actualiza aparte.
- El marketplace `claude-plugins-official` no acepta envíos por el portal.
- Por verificar antes de usar: la cabecera `anthropic-version` de `/v1/skills`.

### Enviar un plugin al directorio de Anthropic (hecho con `test-gate` y `pgtap-rls`, 2026-11-12)

**Antes de abrir el portal:**
- `plugin.json` con los campos del listado (la plantilla ya los trae): `displayName`, `description`, `homepage`, `repository`, `keywords`, `documentationUrl`, `supportUrl` (issues), `privacyPolicyUrl` (`PRIVACY.md` de la raíz), `termsOfServiceUrl` (`LICENSE`).
- `.claude-plugin/icon.png` revisado a tamaño real: el portal lo toma la primera vez.
- README con lo de la fase 3 (punto 7) y `npx skills` con versión fija.
- `check-skill.mjs --portable`, `--profile directory` y `claude plugin validate . --strict` en verde; commit y push a `main`.
- La cuenta dueña del listado es una decisión del usuario (personal o de organización); el correo de contacto no va en el repo.

**Portal** (`claude.ai/directory/manage` → Submit new → Plugin bundle). Cada plugin es un envío aparte.

| Paso | Qué poner | Notas |
|---|---|---|
| 1 Source | Repository `AndresDiagoM/agent-testing-skills`; Plugin path `plugins/mi-skill`; Branch `main` → Validate | Si se valida la raíz, sale "This folder is a marketplace, not one plugin": hay que elegir la carpeta. Comprobar que el commit mostrado (`main @ <sha>`) es el último; si no, recargar |
| 2 Listing details | Se lee de `plugin.json` y del README; para cambiar algo se edita el repo y se revalida | Superficies: Claude Code siempre; Cowork solo si se probó; Claude apps (web/móvil) **no** para skills que necesitan terminal y repo local |
| 3 Data handling | Datos personales: No · Envía datos a otro servicio: No · Retención: Not retained · Menores de 18: No | Válido mientras la skill y sus scripts no hagan llamadas de red. Las plantillas que leen credenciales de prueba del entorno del usuario no cuentan como datos personales |
| 4 Compliance | Correo de contacto (privado) y 4 confirmaciones | Las confirma el usuario después de leer los Directory Terms y la Directory Policy; el agente no las marca por él |
| 5 Review and submit | Auto-publish **apagado** en la primera versión; "Scheduled check only" (cada ~6 h) o webhook de GitHub (necesita guardar un secreto en el repo) | Con auto-publish apagado, cada push a `main` crea una versión candidata que el usuario publica a mano |

**Avisos que salen y qué significan** (ninguno bloqueó el envío):

| Aviso | Causa en nuestro repo | Acción |
|---|---|---|
| `UNKNOWN_KEY` en `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl` | Claude Code no lee esos campos; solo el directorio | Ninguna: el portal dice "No action needed". Quitarlos deja el listado en "Not set" |
| README "download-and-execute shell pattern" | `npx skills add …` | Fijar versión (`npx skills@1.7.4`); el aviso puede quedar, es informativo |
| "Ask the user for the value through a userConfig option (sensitive: true)" | Plantillas que leen contraseñas de prueba de variables de entorno | Ninguna: el plugin no ejecuta esas plantillas; explicarlo en notas si hay campo |
| Scripts o archivos fuera de los tipos permitidos | `.mjs`, `.ts`, `.sql` del kit y fixtures | Hoy no se rechaza; más adelante solo organizaciones verificadas. Plan B: sacar el kit del plugin y dejarlo solo en GitHub |
| Claves de frontmatter fuera de la lista | `compatibility`, `metadata` del estándar Agent Skills | Hoy no se rechaza; si se exige, quitarlas del `SKILL.md` (se pierde algo de portabilidad) |
| `icon.png` "let through without being read as code" | El ícono | Ninguna |

**Después de enviar:** el escaneo de seguridad y la revisión llegan al correo de contacto. La primera versión la publica el usuario o el revisor; las siguientes se publican a mano mientras auto-publish esté apagado. Al subir una versión: bump en `plugin.json`, CHANGELOG, tag, y revisar en el portal que la nueva versión pasó el escaneo.

**Puerta 5:** solo para skills sin campos exclusivos de Claude Code; `check-skill.mjs --portable` sin errores.

## Fase 6: Seguridad y mantenimiento

**Antes de cada release:**
- Revisar `scripts/`: sin llamadas de red, lecturas de archivos ni comandos que no correspondan al propósito declarado. Sin secretos.
- `allowed-tools`: solo lo mínimo. Recordar que pre-aprueba herramientas para ese turno y no restringe las demás.
- Nada que descargue y ejecute código remoto.

**Mantenimiento:**
- Cada cambio: subir `version`, anotar en `CHANGELOG.md`, volver a correr la puerta 2 (solo los casos afectados y luego una corrida completa).
- Issues de usuarios: convertir cada fallo de activación en un caso nuevo de `evals/`.
- `/skill-doctor` en una sesión con la skill instalada, para ver su costo de contexto.

**Puerta 6:** checklist de seguridad marcado en `CHECKLIST.md` para la versión que sale.

---

## Referencias
- Estándar: https://agentskills.io/specification
- Skills en Claude Code: https://code.claude.com/docs/en/skills
- Plugins y marketplaces: https://code.claude.com/docs/en/plugins/create-marketplace.md · https://code.claude.com/docs/en/plugins/publish.md
- Evals: https://code.claude.com/docs/en/plugin-evals.md
- API de skills: https://platform.claude.com/docs/en/build-with-claude/skills-guide
- `npx skills`: https://github.com/vercel-labs/skills
- Ejemplos de Anthropic: https://github.com/anthropics/skills
