# feat(mova): Centro Financeiro Inteligente com Baileys e homologação controlada

## 1. Objetivo
Receber mensagens e documentos financeiros pelo WhatsApp da empresa, interpretá-los com a Claude e transformá-los em **propostas**
que um administrador revisa e aplica no Financeiro v2. **Tudo desligado por padrão**: este PR não muda o comportamento de produção.

## 2. Arquitetura
WhatsApp → Gateway Baileys atual (mesma sessão, gancho aditivo em `messages.upsert`) → filtro (grupos configurados / um contato privado
verificado) → **canal isolado** com URL e segredo HMAC próprios → backend MOVA (`/internal/mova`) → fila com lease → motor → IA (orçamento) →
proposta → aprovação humana → Financeiro v2 → resposta opcional pela rota `/internal/mova/messages` do Gateway.

## 3. Componentes novos
- `backend/src/modules/mova-financeiro/` (contratos, motor, fila, evidências, aprovação, IA, operação/controle/orçamento)
- `backend/src/modules/fv2-integracao/mova.js`, `movaRotas.js` (única camada que conhece o Financeiro)
- `gateway-whatsapp/src/movaGrupo.js`, `movaHomologacao.js`, `movaCanal.js`
- `frontend/financeiro-v2/centro-financeiro.html` + `centroFinanceiro*.js/css`
- `docs/mova-financeiro/01…08`

## 4. Migrações
`database/mova-financeiro/migracoes/0001…0004` — schema próprio `mova`, só aditivas, aplicadas **apenas** no banco do MOVA (homologação).
Nenhuma migração da plataforma nem do Financeiro v2.

## 5. Permissões
Reutiliza as ações do Financeiro v2: `ver` (caixa, estado, erros da unidade), `aprovar`/`aplicar`/`registrar` (decidir propostas), `documentos`
(arquivo da evidência), `configurar` (interruptores e falhas gerais). Identidade de serviço com `ver` apenas (sessões `pode_escrever=false`).

## 6. Isolamento
Unidade sempre a da sessão; falhas sem unidade só como metadados, para quem pode configurar, das conversas da unidade; marca obrigatória
`MOVA_HOMOLOGACAO:<marca>` no banco do MOVA **e** no do Financeiro; configuração contraditória ou incompleta bloqueia; segredo do canal ≠ segredo principal.

## 7. Anthropic
`claude-opus-5-5` com saídas estruturadas; orçamento persistente reservado **antes** de cada chamada (padrão 200 chamadas / US$ 10; piloto 20 / US$ 1);
banco do orçamento indisponível ⇒ nenhuma chamada; sem transcrição de áudio.

## 8. Controles de ativação
Variáveis `MOVA_HABILITADO`, `MOVA_RECEBIMENTO_HABILITADO`, `MOVA_PROCESSAMENTO_HABILITADO`, `MOVA_IA_HABILITADA`, `MOVA_ENVIO_HABILITADO`,
`MOVA_SUSPENSO` e interruptores em tempo real (`mova.controle`) com auditoria. Gateway: `WHATSAPP_MOVA_*` (sem elas, o MOVA não liga).

## 9. Testes
MOVA 96/96 (PostgreSQL, incluindo o fluxo como `mova_app`) · Financeiro v2 732/732 · Gateway 1092/1092 · frontend 2040/2040 · navegador 6/6 ·
backend completo só com falhas preexistentes. Homologação local no projeto Supabase de teste com login real e TOTP: 22/22 + aplicação real
no Financeiro de teste (IA simulada na rede).

## 10. Riscos conhecidos
Reinício do Gateway reconecta a sessão; nova tentativa após falha transitória chama a IA de novo (limitado pelo orçamento); ver doc 08 § 9.

## 11. Publicação
Doc 08 § 7: Fase A passiva (merge com tudo desligado; Gateway sem `WHATSAPP_MOVA_*`), B recebimento privado, C processamento, D respostas —
cada fase com autorização própria.

## 12. Reversão
Doc 08 § 8: suspensão funcional imediata (sem tocar no WhatsApp); redeploy do backend e do Gateway anteriores; nenhuma migração a desfazer em produção.

---
Checklist do revisor
- [ ] Sem segredos, números reais ou identificadores de loja no diff
- [ ] `app.js`: rota `/internal/mova` só existe com variáveis
- [ ] Gateway: sem as variáveis MOVA, comportamento idêntico (testes 1092/1092)
- [ ] Nenhuma migração de plataforma/Financeiro
- [ ] Não fazer merge sem a autorização da Fase A

🤖 Generated with [Claude Code](https://claude.com/claude-code)
