# Núcleo Mentorados — Painel Administrativo

Aba nova do Painel Administrativo que mostra a evolução de cada empresa **antes e durante** a mentoria e gera
apresentações executivas versionadas. Nada aqui escreve em registros financeiros oficiais.

## 1. Diagnóstico da arquitetura (reutilizada)

| Camada | O que já existia | Como o Núcleo usa |
|---|---|---|
| Frontend | SPA em JS puro; Painel Administrativo em `painelAdm*.js` (menu `TELAS_PADM`, despacho `renderViewPadm`) | aba `nucleo-mentorados` delegada a `nucleoMentorados.js`, mesmo padrão de Performance/Agenda |
| Backend | Express; `administrativoRouter` com `requirePainelAdministrativo` + MFA dormente + limite de taxa no router inteiro | sub-router `/administrativo/nucleo-mentorados` montado dentro dele: herda toda a cadeia |
| Banco | Supabase/Postgres; `organizacoes`, `unidades`; Dashboard iFood em `lancamentos_financeiros_diarios` (snapshot **acumulado** do mês; meses de "lançamento mensal" em fatias diárias) | leitura só; o valor mensal é calculado pelas funções oficiais do Dashboard (`snapshotFinanceiroMaisRecente`, `desempenhoParaTicketMedio`, `novosClientesAcumulados`) |
| Auditoria | `shared/auditoria.js` (`plataforma_auditoria`) | toda escrita do Núcleo é auditada |
| Leitor de planilhas | `xlsx` (SheetJS) já no backend | leitor novo por rótulo, sem dependência nova |

A aba existente "Rede de Associados" (`/administrativo/mentorados`) lista **contas de acesso**, não empresas
mentoradas; continua igual.

## 2. Lacunas de dados (preenchidas pela migration 162)

- Não havia cadastro de **quem é mentorado**, data de entrada, renovação, mentor, cidade/UF → `mentoria_participantes`
  (vínculo explícito, um a um ou em massa, de empresas já cadastradas; nenhuma entra sozinha). A data de entrada pode
  ficar **pendente** (nunca é presumida): sem ela não há comparativos, e a listagem aponta a pendência.
- Escolha da fonte válida quando planilha e Dashboard divergem → `mentoria_escolhas_fonte` (período, grupo, fonte,
  justificativa, autor; revogação também justificada; nada se apaga).
- Mudanças de modelo operacional (ex.: Marketplace → Full Service) → `mentoria_registros` tipo `mudanca_operacional`.
- Histórico anterior à plataforma não existia → `mentoria_historico_mensal` + `mentoria_importacoes` (hash do arquivo).
- Diagnóstico, estratégias, metas, evidências → `mentoria_registros`.
- Apresentações versionadas com retrato dos números → `mentoria_apresentacoes` (somente inserção; trigger impede update).
- Todas com RLS ligado e sem policy; `anon`/`authenticated` sem grant (só o backend, com service_role).

## 3. Modelo de integração

- **Fontes por mês e por grupo** (`calc.consolidarSerie`): grupo *financeiro* (vendas, taxas, serviços, entregadores)
  e grupo *desempenho* (pedidos, vendas da aba Desempenho, novos clientes). Em cada grupo o mês vem de **uma** fonte:
  1) a **escolha registrada** mais recente que cobre o mês (se a fonte escolhida tiver o dado); senão
  2) a fonte padrão da empresa — **Dashboard iFood** (a planilha é histórico complementar); senão a outra.
  A fonte não usada nunca é somada; quando as duas têm o grupo, cada diferença acima de R$ 1,00 vira **divergência**,
  marcada como resolvida quando há escolha. Os registros oficiais do Dashboard iFood nunca são alterados.
- **Mudança de modelo operacional** dentro da janela comparada: taxas de entregadores, % entregadores e % total com
  entregadores deixam de ser comparáveis (motivo explícito); metas desses indicadores ficam "não avaliáveis" no ciclo
  que mistura modelos; gráficos e slides mostram o marco. Ausência de taxa de entregadores nunca é lida como economia.
- **Períodos** (`calc.periodosDaMentoria`): o mês de entrada é o 1º mês da mentoria; "antes" = 12 meses anteriores;
  ciclo *k* = 12 meses a partir de entrada + 12·(k−1). Ciclo em curso é **parcial** e é comparado aos mesmos meses do
  ano anterior. O mês corrente (em andamento) fica fora dos períodos e dos gráficos.
- **Destaque**: listagem, visão geral, metas e slides usam o último ciclo **completo**; o ciclo em curso aparece à parte.

## 4. Regras de cálculo (cobertas por testes)

- Dinheiro em centavos inteiros; ausência = `null` (nunca 0); mês sem o indicador sai do numerador **e** do denominador.
- Percentual agregado = Σ componente ÷ Σ vendas dos mesmos meses (ponderado), nunca média de percentuais.
- Indicador percentual varia em **p.p.**; valores variam em %. Base zero ou ausente → sem variação.
- Comparação só com cobertura completa dos dois lados; senão, valores aparecem com "não comparável" e o motivo.
- "Vendas" = valor das vendas no extrato do iFood (não é faturamento total). Saldo de precificação é folga em p.p.,
  não lucro. Oportunidades nos slides são fatos medidos; nenhuma causa é atribuída à mentoria.

## 5. Importação da planilha (idempotente, em duas etapas)

1. **Prévia** (`POST …/importacoes/previa`): lê o arquivo, não grava nada e devolve período, duplicidade (hash já
   importado?), meses novos/substituídos/iguais, cobertura por campo, sobreposição e divergências com o Dashboard
   iFood, metas lidas dos rótulos, avisos (ex.: 0% com valor vazio = "zero artificial") e notas do mentor.
2. **Confirmação** (`POST …/importacoes`): exige o hash exibido na prévia; a função `mentoria_importar_historico`
   grava importação + meses numa transação. Mesmo arquivo de novo = devolve a importação existente sem regravar.

## 6. Rotas (`/api/v1/administrativo/nucleo-mentorados`)

`GET /` · `GET /candidatas` (com uso do Dashboard iFood nos últimos 90 dias) · `POST /vinculos` (em massa, exige
`confirmacao: true`, não duplica) · `GET /:org` · `PUT /:org` · `POST|PUT|DELETE /:org/registros[/:id]` ·
`POST /:org/fontes` · `POST /:org/fontes/:id/revogacao` ·
`POST /:org/importacoes/previa` · `POST /:org/importacoes` · `POST /:org/apresentacoes` ·
`GET /:org/apresentacoes/:id` · `POST /:org/apresentacoes/:id/exportacoes`.
Toda consulta filtra pela empresa do parâmetro; ids de outra empresa → 404. Sem a migration 162 → 503
`NUCLEO_NAO_INSTALADO` (o resto do Painel segue funcionando).

## 7. Navegação persistente do Painel Administrativo

O endereço guarda onde o administrador está (`rotaPainelAdm.js`):
`#/painel-adm/<tela>`, `#/painel-adm/nucleo-mentorados/<empresa>/<aba>` e
`…/apresentacao/<id>/<slide>`. No F5, em link direto ou em outra aba, o boot reabre o Painel nesse ponto, sem passar
pela seleção de unidades — só para contas com o acesso no `/me`, e com a confirmação do backend (`/administrativo/ping`;
ids inexistentes ou de outra empresa → 404). Sessão expirada: login e volta ao mesmo endereço. Trocar de ambiente,
sair ou ter o acesso revogado limpa a rota. O hash usa `replaceState` (não polui o Voltar do navegador).

## 8. Modo Apresentação

10 slides (capa, diagnóstico, estratégias, vendas, evolução, pedidos/clientes/ticket, eficiência, metas,
oportunidades, plano), palco 16:9 escalável (notebook e projetor), teclado (←/→, PageUp/PageDown, Espaço,
Home/End, N notas, F tela cheia, I fontes, P PDF, Esc), notas privadas só no painel do apresentador, fontes e
fórmulas por slide, ocultação de slides/indicadores sem dados, PDF pela impressão do navegador (uma página
16:9 por slide, cores preservadas, sem notas privadas). Compartilhamento externo **desativado** até existir uma
política de autorização.

## 9. Testes

- `backend/test/nucleo-mentorados/`: cálculo, períodos, ano incompleto, ausência, ponderação, crescimento ±,
  duplicidade, divergência, leitor, importação idempotente, isolamento entre empresas, permissões HTTP,
  apresentações. `referencia-real.test.js` confere uma planilha real **localmente** (pulado sem as variáveis).
- `frontend/test/nucleoMentorados.test.js`: listagem, filtros, perfil, slides, gráficos, escape de conteúdo.
- Revisão visual com Playwright CLI (1440, 1920×1080, 1366×768, 390) feita localmente sobre um harness fora do repo.

## 10. Implantação (não feita — exige autorização)

1. Backup: a 162 só CRIA objetos novos (5 tabelas `mentoria_*`, 2 funções, 3 gatilhos); nenhuma tabela existente é
   alterada. Rollback: `162_rollback.sql` (remove só esses objetos). Recomendado confirmar o backup diário/PITR antes.
2. Aplicar `162_nucleo_mentorados.sql` (idempotente; pré-requisitos: `organizacoes`, `perfis`, `set_updated_at`).
3. Merge do PR → deploy do backend e do frontend (o frontend no Render não faz deploy automático). Ordem segura:
   backend → migration → frontend. Backend sem migration responde 503 "não instalado"; frontend antes do backend
   mostra erro só na aba nova.
4. Vincular os mentorados pela tela e importar as planilhas (prévia → confirmação). Para preservar números já
   homologados, marcar "Manter a planilha como fonte válida" na confirmação (gera escolha auditável e revogável).
