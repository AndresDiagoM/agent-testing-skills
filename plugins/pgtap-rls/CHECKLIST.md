# Checklist: pgtap-rls

Ver `../../METODOLOGIA.md` para el detalle de cada fase.

## Fase 1: Diseñar
- [ ] 3 a 5 prompts que deben activarla, y 2 o 3 que no
- [x] `description`: qué hace y cuándo usarla, en menos de 1024 caracteres
- [x] Cuerpo de menos de 500 líneas; el detalle está en `references/`
- [x] **Puerta 1:** `node scripts/check-skill.mjs pgtap-rls` sin errores

## Fase 2: Probar en local
- [ ] Probada a mano con `claude --plugin-dir ./plugins/pgtap-rls`
- [ ] Casos `trigger-*`, `quality-*` y negativos escritos
- [x] **Puerta 2:** `claude plugin eval ./plugins/pgtap-rls` pasa, con delta positivo

## Fase 3: Publicar en el marketplace
- [ ] `version` subida y `CHANGELOG.md` actualizado
- [ ] `claude plugin validate ./plugins/pgtap-rls --strict` y `claude plugin validate . --strict`
- [ ] Push hecho
- [ ] **Puerta 3:** instalada desde GitHub en una sesión limpia y se activa

## Fase 4: Otros agentes
- [ ] **Puerta 4:** `npx skills add ... --skill pgtap-rls` probado en un agente más; README actualizado

## Fase 5: Canales de Anthropic (opcional)
- [ ] `node scripts/check-skill.mjs pgtap-rls --portable` sin errores
- [ ] claude.ai / API / directorio: ___

## Fase 6: Seguridad (por release)
- [ ] `scripts/` revisados: sin red, archivos ni comandos ajenos al propósito; sin secretos
- [x] `allowed-tools` omitido (decisión D13)
- [x] **Puerta 6:** marcado para la versión ___

## Pendiente de v0.1 (necesita el stack de Supabase del proyecto de referencia levantado por el usuario)
- [ ] Ejecutar cada SQL de `assets/` y los snippets de `references/` (lista en `skills/pgtap-rls/references/VERSIONS.md`)
- [ ] Capturar fixtures TAP reales de CLI 3.1.0 y reemplazar los sintéticos
- [ ] Confirmar `is_empty(... returning 1)`, lo que lee `auth.uid()` y si el CLI acepta rutas fuera de `supabase/`
- [ ] Evals quality-1..5 con el stack arriba (no se corrió `claude plugin eval`)
