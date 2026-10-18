# 13 — F-1 (integridade do pré-fechamento) e F-2 (UI após 409) — implementação do Agente 1

Data: 2026-10-18 · Base: `integracao/gestao-financeira` @ `6cb2305` · Decisão do usuário: corrigir F-1 e F-2 antes do T3; F-3/F-4 viram verificações **obrigatórias do T3**; 122 sem promoção; revisão independente **pendente**. Nada publicado; sem migration remota; concessões desligadas.

## Rótulos (nada está homologado de forma independente)
| Item | Estado |
|---|---|
| F-1 (impressão digital + trava + guarda de mês fechado) | **IMPLEMENTADO · TESTADO LOCALMENTE · AGUARDANDO REVISÃO INDEPENDENTE** |
| F-2 (UI após 409) + legibilidade dos alertas no tema escuro | **IMPLEMENTADO · TESTADO LOCALMENTE · AGUARDANDO REVISÃO INDEPENDENTE** |
| T3 / Supabase descartável | **NÃO FEITO** |

## 1. Diagnóstico
- **F-1.** As entradas da regra de conciliação `fin_contas.tipo_conta`, `fin_contas.canal_referencia` e `fin_sangria_excecoes` não entravam na impressão digital do pré-fechamento nem tomavam a trava do período. Efeito (demonstrado na auditoria): entre a prévia e o fechamento a mudança passava **silenciosamente** (sem 409 de dados) e, durante a transação de fechamento, outra sessão alterava essas entradas sem esperar; o banco também não impedia mudar tipo/canal de conta com movimento em **mês fechado** (só a aplicação).
- **F-2.** Após o 409 o diálogo mostrava o erro mas **reabilitava** "Fechar período" com a mesma impressão digital; reenviar repetia o 409. Descoberta extra na QA visual: `.fin-alerta--bad/--warn` usam fundo claro nos dois temas e herdavam texto claro no tema escuro → **ilegíveis** (pré-existente).

## 2. Alterações
**SQL — `proposta-122/122_conciliacao_periodos.provisorio.sql` e `122_rollback.provisorio.sql`**
- `fin_fingerprint_periodo`: +2 segmentos determinísticos (ordenados por id): (a) `id:tipo_conta:canal` das contas **com movimento no mês**; (b) `id:categoria` das exceções de sangria **ativas** cuja categoria tem **saída** no mês. Só o que pode afetar *este* mês ⇒ sem 409 espúrio por operações alheias.
- `fin_periodo_travar(org, unidade, mes) → status` (FOR SHARE, devolve o status; cria a âncora como `fin_periodo_travar_e_checar`). EXECUTE: `service_role` (necessário aos gatilhos), não `anon`/`authenticated`.
- Gatilho `trg_fin_contas_regra_conciliacao` (`BEFORE UPDATE OF tipo_conta, canal_referencia`, só quando muda): toma a trava dos meses com movimento da conta, em ordem crescente; **recusa** (`fin_periodo_fechado`) se algum for `fechado` (guarda no banco da regra que antes só existia na aplicação).
- Gatilho `trg_fin_sangria_excecoes_regra` (`BEFORE INSERT/UPDATE/DELETE`): toma a trava dos meses em que a categoria tem saída; **não recusa** mês fechado (configuração da unidade; snapshot imutável) — serializa com o fechamento.
- Pós-condição: aborta se os gatilhos faltarem/estiverem desabilitados ou se `fin_periodo_travar` ficar exposta. Rollback remove gatilhos e funções novas.
- Sem deadlock: gatilhos travam FOR SHARE em ordem crescente de mês; só `fin_fechar_periodo` toma FOR UPDATE (um mês).

**Frontend**
- `frontend/src/financeiro/periodos.js`: `atualizar()` (descarta a impressão digital **antes** de reler; desabilita a confirmação; relê o pré-fechamento) e `invalidar()` (409 `FIN_PERIODO_CONFLITO_DADOS`/`_VERSAO`/`FIN_CONCILIACAO_DIVERGENTE`): descarta a prévia, desabilita a confirmação, mostra "**Os dados financeiros deste mês mudaram…**" e o botão **Atualizar pré-fechamento**; `_fechar` recusa enviar sem prévia válida.
- `frontend/src/financeiro/ui.js`: `dialogo` respeita `err.bloquearReenvio` (mantém o botão desabilitado).
- `frontend/src/financeiro/financeiro-paginas.css`: `.fin-alerta--acao` (responsivo) e texto escuro em `.fin-alerta--bad/--warn` (legível no tema escuro).

**Testes/QA novos:** `backend/testes-seguros/pg/f1_concorrencia.sh` (sessões PostgreSQL reais), `backend/testes-seguros/qa-visual/qa-f2.mjs` + endpoints `/qa/mes-limpo`, `/qa/novo-mes`, `/qa/mudar-dados` no servidor de QA (mudança **real** de dados → 409 **real** do domínio).

## 3. Evidências (PostgreSQL 17 local descartável; privilégios Supabase simulados)
| Prova | Resultado |
|---|---|
| `f1_concorrencia.sh` (31 provas, sessões reais, ids novos a cada execução) | **31/31**: 1) tipo da conta após a prévia ⇒ 409, mês aberto, nova prévia fecha; 2) canal idem; 3) ativar **e** desativar exceção de sangria ⇒ 409; exceção de categoria **sem** saída no mês ⇒ **sem** 409 espúrio; 4) durante o fechamento (transação de 4 s) a mudança de tipo e a criação de exceção **esperaram ~3 s** pela trava; o tipo foi **recusado** após o fechamento (mês preservado) e a exceção **aceita** depois; 5) 409 **não consome** a exceção; nova prévia + reconhecimento fecha e consome 1×; 6) **sem bloqueios indevidos** (renomear/inativar conta, tipo de conta com movimento só em outro mês, lançamento em outro mês, conta de outra unidade, exceção de categoria sem saída: 125–145 ms); 7) mês fechado: tipo/canal recusados **no banco**, conta sem movimento editável, snapshot intacto |
| Mutação da prova F-1 | (A) impressão digital **sem** as entradas ⇒ 7 falhas (a prévia antiga **fecha**); (B) **sem** os gatilhos ⇒ 6 falhas (não espera, tipo muda em mês fechado). Ambos detectados |
| Paridade JS×SQL | **531/531** em 3 sementes (7, 2026, 31337) |
| Adversariais M1/S0–S12 | **70 PASS / 0 FALHA** + complemento 5 PASS; corrida de 3 sessões OK |
| Suíte do Agente 2 (`run.sh`: 10/20/25, concorrência de fechamento, **cancelamento de transferências**, exceção, reaplicação com dados, rollback) | **exit 0** |
| Ciclo 120→121→122 (aplica ×2, rollback, reaplica, rollback 122→121→120, reaplica) | OK; simulação de privilégios **sem falhas** |
| Desempenho (60 mil lançamentos/mês) | impressão digital ~130 ms; fechamento completo ~258 ms (+~30 ms) |
| HTTP integrado + domínio (`test/financeiro` + `test/gestao-financeira-*`) | **235/235** |
| Backend T1 completo | 5386 ok · 3 falhas conhecidas · 25 pulados · 0 violações |
| Frontend (`frontend/test`) | 1530 ok · 0 falhas · 11 pulados (navegador) |
| Navegador real do Agente 2 (`financeiro.browser.test.js`) | **17/17** |
| QA visual integrado (Chrome real) | **56/56** |
| QA da F-2 (Chrome real; **desktop 1366, celular 390, tema escuro**; 409 real) | **30/30** por variação: aviso claro; confirmação desabilitada; mesma prévia **não** reenviável (nenhum POST novo); "Atualizar pré-fechamento" visível; depois de atualizar a confirmação volta **desmarcada** e só então habilitada; fecha; sem rolagem horizontal; diálogo cabe na tela. Capturas em `backend/testes-seguros/qa-visual/shots/50-f2-*.png`, `51-f2-*.png` |

## 4. Migrations e `main` (somente leitura)
`origin/main` @ `3545968` tem 110, 112–119, **123** (Checklist), **124** e **125** (iFood); **120–122 estão livres** (Financeiro mantém a numeração; sem colisão). A branch de integração está **50 commits à frente e 9 atrás** da main. Ensaio sem tocar em nada (`git merge-tree`): **4 conflitos** de conteúdo — `backend/src/routes.js`, `backend/src/shared/modulos.js` (ordem dos módulos: Checklist = 18, 17 = Financeiro), `backend/test/comunicacao-arquitetura-agendamento.test.js`, `backend/test/ifood-migration-103.test.js`. Nada foi incorporado.

## 5. Pendências do T3 (incluindo as decisões novas)
- **F-3 (obrigatória):** teste **fim-a-fim** aplicação real → banco comparando `pendenciasAbertasIds` com `fin_conciliacao_pendencias_ids` (a paridade atual usa os mesmos filtros do serviço, não o código de carregamento).
- **F-4 (obrigatória):** decidir/espelhar a conferência do banco em `repoMemoria.js` ou provar que a cobertura SQL basta; hoje os testes JS só cobrem o mapeamento 409.
- Repetir no Supabase descartável: `f1_concorrencia.sh`, `adversarial122*`, `parity_m1.mjs`, desempenho, `amr_probe.mjs`; papéis reais; PostgREST sem expor `fin_periodo_travar`/validadores.
- Revisão por terceiro independente; só então promover a 122 (`begin/commit`, `lock_timeout`, pós-condição).

## 6. Riscos residuais
- **Visão ao vivo de mês fechado** (tela de conciliação) reflete a configuração **atual** de exceções de sangria: criar/desativar exceção depois do fechamento não é recusado (decisão para não bloquear uma configuração legítima da unidade); o **snapshot e o status** do mês permanecem imutáveis. Alternativa, se o usuário preferir: congelar a conciliação do mês fechado a partir do snapshot.
- Gatilhos criam **âncoras** `fin_periodos` (`aberto`) para os meses com movimento da conta/categoria alterada (mesmo padrão dos lançamentos) e fazem uma varredura por conta/categoria: custo proporcional ao nº de meses com movimento.
- Mudar tipo/canal de conta com movimento em mês fechado agora é recusado **também** no banco; fluxo administrativo que precisasse disso (ex.: correção cadastral) ficará bloqueado até existir reabertura.
- `canal_referencia` entra na impressão digital mas não altera o conjunto de pendências (afeta só a visão por conta); decisão conservadora.
- Limites herdados: flags locais não defendem SQL bruto de `service_role`; `fin_abrir/fingerprint/reabrir` sem `search_path` fixo; revisão **não independente**.
