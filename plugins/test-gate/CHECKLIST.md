# Checklist: test-gate

Ver `../../METODOLOGIA.md` para el detalle de cada fase.

## Fase 1: Diseñar
- [x] 3 a 5 prompts que deben activarla, y 2 o 3 que no
- [x] `description`: qué hace y cuándo usarla, en menos de 1024 caracteres
- [x] Cuerpo de menos de 500 líneas; el detalle está en `references/`
- [ ] **Puerta 1:** `node scripts/check-skill.mjs test-gate` sin errores

## Fase 2: Probar en local
- [ ] Probada a mano con `claude --plugin-dir ./plugins/test-gate`
- [x] Casos `trigger-*`, `quality-*` y negativos escritos (Q5 pendiente: necesita WSL2 con Bash)
- [ ] **Puerta 2:** `claude plugin eval ./plugins/test-gate` pasa, con delta positivo

## Fase 3: Publicar en el marketplace
- [ ] `version` subida y `CHANGELOG.md` actualizado
- [ ] `claude plugin validate ./plugins/test-gate --strict` y `claude plugin validate . --strict`
- [ ] Push hecho
- [ ] **Puerta 3:** instalada desde GitHub en una sesión limpia y se activa

## Fase 4: Otros agentes
- [ ] **Puerta 4:** `npx skills add ... --skill test-gate` probado en un agente más; README actualizado

## Fase 5: Canales de Anthropic (opcional)
- [ ] `node scripts/check-skill.mjs test-gate --portable` sin errores
- [ ] claude.ai / API / directorio: ___

## Fase 6: Seguridad (por release)
- [ ] `scripts/` revisados: sin red, archivos ni comandos ajenos al propósito; sin secretos
- [ ] `allowed-tools` mínimo
- [ ] **Puerta 6:** marcado para la versión ___
