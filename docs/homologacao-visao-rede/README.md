# Homologação da classificação financeira — Visão Geral da Rede

Data: 05/11/2026. Branch conferida antes das alterações: `feat/visao-geral-rede`. Base: commit `a78e479`.

## Resultado

**GO técnico para publicação, sujeito à autorização do responsável.** Nenhuma falha funcional aberta nos cenários executados. Nenhum push, merge, deploy ou migration foi executado. Arquivos preexistentes de outras demandas foram preservados.

- Chrome 156.0.8078.80 via Playwright, desktop 1440 × 1000 e móvel 390 × 844.
- **30 verificações de navegador: 30 PASS / 0 FAIL.**
- **793 testes de regressão: 793 passaram / 0 falhas / 0 ignorados.**
- `git diff --check` aprovado.

## Ambiente e origem dos dados

Frontend real (`index.html`, shell `painelAdm.js`, views e cliente HTTP `painelAdmApi.js`) servido somente em `127.0.0.1:4188`. Os endpoints locais chamam os serviços e repositórios reais da aplicação. A sessão de QA é fictícia e local: este roteiro não substitui testes de autenticação/autorização.

A configuração `.env.test-integracao` aponta para o projeto de homologação descartável conhecido, distinto da produção. A guarda do servidor aceita apenas GET/HEAD para o REST desse projeto e bloqueia escritas e destinos externos. O navegador só acessa o servidor em loopback; nenhuma credencial do banco é enviada ao navegador.

O banco de homologação possui 30 organizações, 39 unidades e seis lançamentos. A rede elegível contém somente **Loja Teste iFood**, sem lançamentos financeiros próprios. Por isso, os dados reais cobriram **Sem dados** e o respectivo detalhe na competência 2026-10. Os lançamentos existentes pertencem a outra unidade, fora da elegibilidade normal; sua elegibilidade não foi alterada.

Para completar a cobertura sem gravar no banco, o segundo modo usa 11 unidades e duas empresas **controladas em memória**. O único componente substituído é a resposta do transporte REST: os cálculos, resolução de metas, reconciliação, serviços administrativos, serviço do Dashboard e frontend são os mesmos do código da aplicação. As capturas identificam a origem dos dados em uma faixa azul. Não representam dados de clientes em produção.

Recursos externos de navegador foram bloqueados. A distribuição de situações foi renderizada e validada. O canvas de comparação de percentuais do detalhe depende de Chart.js externo e degradou para vazio; a comparação desta demanda foi feita pela linha real da tabela de Indicadores de Rentabilidade, que permaneceu visível. O bloco auxiliar da Agenda de Desenvolvimento não faz parte da homologação e aparece indisponível no ambiente isolado.

## Divergências encontradas e corrigidas

1. **Lançamento mensal:** o recorte mensal da rede herdava a exclusão das linhas `distribuicao_mensal` do relatório semanal. A unidade era Sem dados na rede, embora o Dashboard calculasse 10% de Total de deduções, meta 12%, limite 15% e Dentro da Meta. O recorte mensal agora usa `financeiroMensalDaUnidade`, um adaptador do cálculo já existente `faturamentoDaUnidade`/`snapshotFinanceiroMaisRecente`. Snapshot real continua prioritário, e a distribuição mensal continua sendo fallback, sem somar acumulados de dias. Cards, evolução, composição e tabelas mensais passam a incluir esses valores de forma coerente. O cálculo semanal não foi alterado.
2. **Mudança de modalidade:** o período misto tinha classificação financeira correta, mas aparecia como “—” e não entrava em nenhum ranking. Agora recebe o rótulo **Misto (Marketplace / Full Service)**, opção de filtro própria e bloco de ranking separado. Suas metas continuam ponderadas pelo faturamento conciliado de cada regime.

Na rodada anterior às correções: **27 PASS / 3 FAIL** (cards/distribuição afetados pelo lançamento mensal, identificação/ranking misto, comparação do lançamento mensal). Todas as três verificações passaram na repetição final.

## Matriz PASS/FAIL

| Verificação | Origem | Resultado |
| --- | --- | --- |
| Rede com dados reais de homologação: Sem dados | homologação real | PASS |
| Detalhe real da mesma unidade/competência | homologação real | PASS |
| Cards e distribuição: quatro estados financeiros | controlado | PASS |
| Rankings, ordenação e badges | controlado | PASS |
| Mudança de modalidade tem identificação e ranking próprios | controlado | PASS |
| Filtro financeiro em_dia | controlado | PASS |
| Filtro financeiro atencao | controlado | PASS |
| Filtro financeiro critica | controlado | PASS |
| Filtro financeiro sem_dados | controlado | PASS |
| Filtros por empresa, unidade e modalidade | controlado | PASS |
| Comparação rede × Indicadores: FS Acima do Limite | controlado | PASS |
| Comparação rede × Indicadores: FS Dentro da Meta | controlado | PASS |
| Comparação rede × Indicadores: FS Dentro do Limite | controlado | PASS |
| Comparação rede × Indicadores: FS Meta dinâmica | controlado | PASS |
| Comparação rede × Indicadores: MP Acima do Limite | controlado | PASS |
| Comparação rede × Indicadores: MP Dentro da Meta | controlado | PASS |
| Comparação rede × Indicadores: MP Dentro do Limite | controlado | PASS |
| Comparação rede × Indicadores: MP Lançamento mensal | controlado | PASS |
| Comparação rede × Indicadores: MP Meta personalizada | controlado | PASS |
| Comparação rede × Indicadores: Unidade Mudança de modalidade | controlado | PASS |
| Comparação rede × Indicadores: MP Sem dados | controlado | PASS |
| Empresa com múltiplas unidades usa pior classificação financeira | controlado | PASS |
| Troca de mês recalcula situação e mantém competência no detalhe | controlado | PASS |
| Troca de ano recalcula os dados do período | controlado | PASS |
| Modalidade histórica: setembro Marketplace, outubro misto | controlado | PASS |
| Monitoramento Dashboard iFood mantém exclusivamente critérios operacionais | controlado | PASS |
| Tabela mantém badges acessíveis ao rolar horizontalmente | controlado | PASS |
| Layout móvel e badges | controlado | PASS |
| Sem erros JavaScript na navegação | navegador | PASS |
| Nenhuma escrita ou acesso à produção | segurança | PASS |

## Comparação da rede com Total de deduções — outubro/2026

A comparação conferiu percentual, meta ideal, limite, status da linha e badge administrativo para a mesma unidade/competência. O Dashboard mantém seu rótulo homologado “Atenção” quando ultrapassa o limite; esse estado é traduzido para “Crítica” exclusivamente na situação principal da rede.

| Unidade controlada | Modelo | Atual | Meta ideal | Limite | Indicadores | Rede |
| --- | --- | ---: | ---: | ---: | --- | --- |
| FS Acima do Limite | full_service | 27,00% | 20,00% | 25,00% | atencao | critica |
| FS Dentro da Meta | full_service | 18,00% | 20,00% | 25,00% | dentro_da_meta | em_dia |
| FS Dentro do Limite | full_service | 23,00% | 20,00% | 25,00% | dentro_do_limite | atencao |
| FS Meta dinâmica | full_service | 23,00% | 24,00% | 25,00% | dentro_da_meta | em_dia |
| MP Acima do Limite | marketplace | 16,00% | 12,00% | 15,00% | atencao | critica |
| MP Dentro da Meta | marketplace | 10,00% | 12,00% | 15,00% | dentro_da_meta | em_dia |
| MP Dentro do Limite | marketplace | 14,00% | 12,00% | 15,00% | dentro_do_limite | atencao |
| MP Lançamento mensal | marketplace | 10,00% | 12,00% | 15,00% | dentro_da_meta | em_dia |
| MP Meta personalizada | marketplace | 9,00% | 8,00% | 10,00% | dentro_do_limite | atencao |
| Unidade Mudança de modalidade | misto | 20,00% | 16,13% | 20,16% | dentro_do_limite | atencao |
| MP Sem dados | marketplace | — | 12,00% | 15,00% | sem_dados | sem_dados |

### Outros casos conferidos

- Meta personalizada MP: 9%, ideal 8%, limite 10% → Atenção, embora a referência global 12%/15% produzisse Em dia.
- Meta dinâmica FS: 23%, ideal derivado 24%, limite 25% → Em dia; a meta cadastrada original era 20%.
- Modalidade histórica: a unidade de troca é Marketplace em setembro; em outubro, Marketplace até dia 15 e Full Service a partir de 16. O indicador e as metas compostas coincidiram entre rede e Dashboard.
- Troca de competência: MP Dentro da Meta fica Em dia em outubro/2026 (10%), Crítica em setembro/2026 (17%) e Atenção em outubro/2025 (14%). O detalhe manteve a mesma competência selecionada.
- Empresa com múltiplas unidades: a situação mantém a pior classificação financeira entre as unidades da empresa/modalidade; os valores monetários são consolidados pela soma.
- Monitoramento: FS Acima do Limite é financeiramente Crítica e operacionalmente Em dia, com preenchimento completo. MP Dentro da Meta é financeiramente Em dia e tem pendências operacionais. Nenhum arquivo do motor de monitoramento foi alterado.

## Evidências

- [Matriz final completa e valores comparados](evidencias/final/matriz.json).
- [Matriz anterior às correções](evidencias/antes/matriz.json).
- [Dados reais de homologação — Sem dados](evidencias/final/01-homologacao-real-sem-dados.png).
- [Detalhe real da mesma unidade](evidencias/final/02-homologacao-real-detalhe.png).
- [Cards e distribuição final](evidencias/final/03-rede-completa.png).
- [Rankings e modalidade mista](evidencias/final/05-ranking-misto.png).
- [Filtro Atenção](evidencias/final/06-filtro-atencao.png).
- [Marketplace — Dentro da Meta](evidencias/final/08-unidade-11.png).
- [Marketplace — Dentro do Limite](evidencias/final/08-unidade-12.png).
- [Marketplace — acima do limite](evidencias/final/08-unidade-13.png).
- [Lançamento mensal corrigido](evidencias/final/08-unidade-16.png).
- [Full Service — Dentro da Meta](evidencias/final/08-unidade-21.png).
- [Full Service — Dentro do Limite](evidencias/final/08-unidade-22.png).
- [Full Service — acima do limite](evidencias/final/08-unidade-23.png).
- [Meta dinâmica](evidencias/final/08-unidade-24.png).
- [Modalidade mista — indicador e meta composta](evidencias/final/08-unidade-25.png).
- [Consolidação por empresa](evidencias/final/09-empresa-consolidada.png).
- [Troca de mês](evidencias/final/10-troca-mes-setembro.png).
- [Troca de ano](evidencias/final/11-troca-ano-2025.png).
- [Monitoramento operacional](evidencias/final/12-monitoramento-operacional.png).
- [Tabela e badges com rolagem horizontal](evidencias/final/13-tabela-badges.png).
- [Layout móvel](evidencias/final/14-mobile.png).

## Reprodução segura

Em um terminal na raiz do checkout:

```powershell
node --env-file=backend/.env.test-integracao backend/testes-seguros/visao-rede/servidor.mjs
```

Em outro terminal, na raiz:

```powershell
node backend/testes-seguros/visao-rede/homologar.mjs
```

O roteiro exige Chrome e o Playwright já instalado em `worker-martinbrower/node_modules/playwright`. Não instala dependências nem inicia o servidor de produção. Os cenários estão em `backend/testes-seguros/visao-rede/cenarios.mjs`. Não execute o servidor com credenciais de produção; ele recusa qualquer projeto diferente da homologação descartável permitida.

Os 793 testes usam variáveis fictícias com URL `http://127.0.0.1:9`, sem carregar `.env`, abrangendo os testes administrativos (exceto comunicação/mentorados), os testes do Dashboard de rentabilidade/período misto/proteção/total de deduções/ajustes e todos os testes `frontend/test/painelAdm*.test.js`. Há três novas regressões para lançamento mensal e identificação/filtro/ranking misto.

## Pendências e limites

Nenhuma divergência aberta no escopo executado. Os casos financeiros positivos foram homologados com cenários controlados porque o banco de homologação não oferece unidades elegíveis com esses dados. Ampliar essa massa real seria uma validação adicional, sem necessidade de alterar produção. Login/MFA, Agenda de Desenvolvimento e o canvas externo do gráfico do detalhe não foram objeto deste roteiro. Publicação continua dependente de autorização; esta homologação não executou publicação.
