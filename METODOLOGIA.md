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
- Por verificar antes de usar: los criterios de revisión del directorio y la cabecera `anthropic-version` de `/v1/skills`.

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
