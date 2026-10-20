# 12 — Auditoria da M1/O-1 (commit `f2b1a40`) — resultado: **APROVADO COM RESSALVAS** (local)

Data: 2026-10-18 · Revisor: **Agente 1, no papel de revisor** (o Agente 2 está indisponível; o usuário determinou que o Agente 1 assuma as duas partes). **Atenção ao limite desta aprovação:** quem implementou também revisou. Foi feita uma passada adversarial separada (tratando o código como suspeito, ampliando a bateria e procurando falhas), mas **não é revisão independente**. Ela **não substitui** (a) o T3 no Supabase descartável nem (b) uma revisão por outra pessoa/agente quando houver. Nada foi publicado; sem migration remota; concessões desligadas; 122 **não** promovida.

## Resultado
**APROVADO COM RESSALVAS — APTO PARA T3 (Supabase descartável).** Nenhum defeito que reabra o R-1 foi encontrado. Três ressalvas abaixo; duas são endurecimentos recomendados antes de promover a 122.

## Revisão item a item (arquivo:linha → evidência)
| # | Item | Resultado |
|---|---|---|
| 1 | `fin_conciliacao_pendencias_ids` (`122…provisorio.sql:265`) | Relida contra `conciliar()` (`conciliacao.js`) regra a regra e contra os filtros reais da aplicação (`repositorio.js` `listarContas` sem filtro por `ativo`; `listarTodosLancamentos` por org+unidade+período, paginado; `repositorio.conciliacao.js` referências `ativa`, resoluções `vigente`, exceções `ativa`). Sem divergência. `STABLE`, invoker, `search_path` fixo, EXECUTE só `service_role` (`:791`) |
| 2 | Equivalência real com `conciliar()` | O oráculo do harness **é** `conciliar()` (importado, não reimplementado). Ampliei o harness: 2 organizações com dados nas mesmas datas, contas **inativas**, dias de fronteira (1/28–31) e meses vizinhos, 31 cenários determinísticos. **526/526 iguais em 3 sementes** (7, 2026, 31337) |
| 3 | Cenários de paridade | Mutação: **16 defeitos deliberados** no SQL (previsto/cancelado contam, exceção de sangria ignorada, resolução revogada conta, referência cancelada conta, saldo anterior entra, caixa em qualquer conta, parcial = resolvida, diferença negativa ignorada, sem referência = zero, vazamento entre unidades/organizações (lançamentos e referências), conta inativa ignorada, 3 fronteiras de data) — **todos os 16 detectados**; outros 3 "mutantes" eram equivalentes (taxa ausente com coalesce em duas formas; resoluções sem filtro de organização, já isoladas por unidade) e foram descartados |
| 4 | Testes 4a / 4f2 / 4k (`20_periodos_conciliacao.test.sql:134, 237, 305–348`) | Revisados: **nenhuma expectativa de segurança afrouxada**; todas ficaram mais estritas (4f2 passou de "qualquer 23514" para `fin_conciliacao_divergente`; 4k ganhou cenário real, troca 1-por-1 real e fechamento por subconjunto). O que mudou foi o contrato (ids fabricados agora recusados) |
| 5 | Lista omitida / incompleta / adulterada | `adversarial122.sql` S11: omitida, fabricada, extra, repetida, com nulo, lista correta sem exceção, exceção + lista omitida, concessão com lista omitida/fabricada — **todas recusadas**; mês permanece `aberto` (70 PASS / 0 FALHA) |
| 6 | Consistência das exceções | S1–S10: pendência nova, substituída (mesmo total), resolvida antes do fechamento, uso duplicado, vencida, MFA 10 min + 22 variações de formato, `sessao_ref`, outra unidade/organização, assinatura antiga — OK. Cobertura por subconjunto, uso único, consumo atômico no fechamento, snapshot com ids do banco |
| 7 | Concorrência | Duas sessões fechando: só uma fecha; lançamento **e referência de conciliação** novos durante o fechamento esperam a trava e são recusados (`fin_periodo_fechado`). **Lacuna** em F-1 abaixo (conta/exceção de sangria não travam) |
| 8 | Assinaturas SQL antigas (`:11–12`, `:809`) | 4 estados (banco novo; vindo de `7913b11`; vindo de `cd35699`; 122 duas vezes): uma assinatura por função; nenhuma sobrecarga `fin_*`; pós-condição aborta se surgir outra. Rollback remove as antigas também |
| 9 | Aplicar / reaplicar / rollback | Ciclo 120→121→122→122→rollback→reaplica→rollback→121→120→reaplica OK; rollback com dados recusa; 0 funções `fin_*` após rollback total; a partir do estado "vindo de rascunho" OK |
| 10 | Volume | 60 mil lançamentos: função 155 ms, fechamento completo 227 ms. **300 mil lançamentos/mês: 480 ms** (linear; usa `ix_fin_lancamentos_periodo (org, unidade, data)` da 121). Sem retenção prolongada de trava além disso |
| 11 | Regras de sangria | O SQL não alterou a regra; reproduz a de `conciliar()` (saída de `caixa_fisico` exceto categorias com exceção ativa × referência `sangria`; dia com saída **ou** referência). Ver F-1 |
| 12 | Resposta de interface ao 409 | `repositorio.util.js:23,54` → 409 `FIN_CONCILIACAO_DIVERGENTE` com texto amigável; `ui.js:115` exibe o texto no diálogo. Ver F-2 |
| — | Numeração de migrations | Sem colisão de 121 (Checklist já é 123 na main); ver LD-015 |

## Atualização (18/10): F-1 e F-2 CORRIGIDAS — ver `13-f1-f2-pre-fechamento.md`; F-3 e F-4 viraram verificações obrigatórias do T3.

## Ressalvas / achados
- **F-1 (baixa–média, RECOMENDADO antes de promover) — entradas da regra fora da trava e da impressão digital.** `fin_contas.tipo_conta`/`canal_referencia` e `fin_sangria_excecoes` não tomam a trava do período e não entram em `fin_fingerprint_periodo`. **Demonstrado**: durante uma transação de fechamento aberta (≈5 s), outra sessão mudou `tipo_conta` para `caixa_fisico` e criou uma exceção de sangria e **terminou em 1 s, sem esperar**. Efeito: (a) entre a pré-visualização e o fechamento a mudança **não** gera o conflito 409 de dados (só a divergência, se afetar o resultado); (b) o snapshot de um mês fechado pode, depois, divergir do recálculo. Não reabre o R-1 (o fechamento decide com o estado do banco no instante do cálculo). **Recomendação:** incluir `tipo_conta` das contas com movimento no mês e as exceções de sangria ativas em `fin_fingerprint_periodo` (muda só um texto md5, a aplicação já usa o do banco), e, opcionalmente, travar a alteração de `tipo_conta`/`canal` de conta com movimento em mês fechado também no banco (hoje só a aplicação bloqueia).
- **F-2 (baixa, UX).** Após o 409, o diálogo mostra o erro mas reabilita "Fechar período" com a **mesma** impressão digital: reenviar repete o 409. Recomendação: em 409 (`FIN_CONCILIACAO_DIVERGENTE`/`FIN_PERIODO_CONFLITO_*`) recarregar o pré-fechamento automaticamente ou oferecer "Recarregar" (`periodos.js:75`, `ui.js:115`).
- **F-3 (informativo).** A paridade valida o SQL contra `conciliar()` com **os mesmos filtros** que o serviço usa; ela não exercita o *código de carregamento* da aplicação (`repositorio*.js`). Verifiquei esses filtros por leitura. Recomendação: no T3, um teste fim-a-fim (aplicação real → banco) que compare `pendenciasAbertasIds` com `fin_conciliacao_pendencias_ids`. Correção ao RR-4: lançamentos são paginados (sem teto); o limite de 5 000 vale para referências e resoluções (`.limit(5000)`): acima disso a lista da aplicação trunca e o fechamento fica **bloqueado** (409), nunca errado.
- **F-4 (informativo).** `repoMemoria.js` não replica a conferência do banco (a prova é em SQL). Os testes JS do domínio não exercitam `fin_conciliacao_divergente` além do mapeamento.
- Limites herdados: flags locais não defendem SQL bruto de `service_role` (F-A/F-D); `fin_abrir/fingerprint/reabrir` sem `search_path` fixo.

## O que esta aprovação NÃO cobre
T3 no Supabase real (papéis, PostgREST, owner, `amr` do MFA); revisão por terceiro independente; carga/concorrência de produção; o fluxo administrativo de concessão (continua **bloqueado**).

## Próximos passos
1. Decidir F-1 (recomendo implementar antes da promoção) e F-2.
2. T3: aplicar 120→121→122 no Supabase descartável; repetir `adversarial122*`, `parity_m1.mjs`, desempenho e `amr_probe.mjs`.
3. Revisão por outra pessoa/agente quando disponível (o material está pronto: docs 10–12, scripts em `backend/testes-seguros/pg/`).
4. Só então promover a 122 (`begin/commit`, `lock_timeout`, pós-condição).
