# Checklist: __NAME__

Ver `../../METODOLOGIA.md` para el detalle de cada fase.

## Fase 1: Diseñar
- [ ] 3 a 5 prompts que deben activarla, y 2 o 3 que no
- [ ] `description`: qué hace y cuándo usarla, en menos de 1024 caracteres
- [ ] Cuerpo de menos de 500 líneas; el detalle está en `references/`
- [ ] **Puerta 1:** `node scripts/check-skill.mjs __NAME__` sin errores

## Fase 2: Probar en local
- [ ] Probada a mano con `claude --plugin-dir ./plugins/__NAME__`
- [ ] Casos `trigger-*`, `quality-*` y negativos escritos
- [ ] **Puerta 2:** `claude plugin eval ./plugins/__NAME__` pasa, con delta positivo

## Fase 3: Publicar en el marketplace
- [ ] `version` subida y `CHANGELOG.md` actualizado
- [ ] `claude plugin validate ./plugins/__NAME__ --strict` y `claude plugin validate . --strict`
- [ ] Push hecho
- [ ] **Puerta 3:** instalada desde GitHub en una sesión limpia y se activa

## Fase 4: Otros agentes
- [ ] **Puerta 4:** `npx skills add ... --skill __NAME__` probado en un agente más; README actualizado

## Fase 5: Canales de Anthropic (opcional)
- [ ] `node scripts/check-skill.mjs __NAME__ --portable` sin errores
- [ ] claude.ai / API / directorio: ___

## Fase 6: Seguridad (por release)
- [ ] `scripts/` revisados: sin red, archivos ni comandos ajenos al propósito; sin secretos
- [ ] `allowed-tools` mínimo
- [ ] **Puerta 6:** marcado para la versión ___
