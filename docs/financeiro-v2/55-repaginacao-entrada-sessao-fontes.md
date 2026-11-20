# 55 — Repaginação: entrada única, fontes por unidade, sessão expirada e desempenho

Escopo: frontend (`frontend/financeiro-v2`, parte da entrada em `frontend/src`) e scripts de teste. Nenhuma fórmula, regra de DRE,
permissão, importador, baixa ou dado de produção foi alterado. Nada foi publicado.

## Causas encontradas

| Sintoma | Causa |
| --- | --- |
| "Duas interfaces" ao entrar | A plataforma (`frontend/src/app.js#entrarNoFinanceiro`) mostrava o próprio shell com cabeçalho "Dashboard Financeiro" e um carregamento neutro, consultava `/financeiro-v2/status` e só então fazia `location.assign` para `/financeiro-v2/`. Era uma **navegação completa** entre duas páginas com layouts diferentes. |
| SAIPOS aparecendo na Subway | O menu do v2 era HTML estático com SAIPOS visível; o item certo só era ajustado depois de `sessao` → `fontes-faturamento` (consulta em série). Pior: se `fontes-faturamento` falhasse, o código caía em `"SAIPOS"` por padrão. |
| Anota Aí / SAIPOS em telas da Subway | Rótulos fixos ("Presencial — SAIPOS", "Anota Aí — SAIPOS"), opções de canal/processadora, nota de Caixa e Bancos, catálogo de relatórios esperados, seção iFood/99Food "Pedidos no relatório SAIPOS". |
| Sessão expirada deixava a tela inútil | Os links "Voltar para a plataforma" só eram criados **depois** de a sessão responder com sucesso; com 401 não havia nenhuma saída. Não havia renovação, o estado financeiro ficava na memória e o texto de erro não oferecia ação. |
| "Voltar à plataforma" não funcionava para quem só tem financeiro | O setor escolhido vive só em memória; ao voltar para `/`, a plataforma reentrava no financeiro e redirecionava de novo. |

## O que mudou

- **Entrada em etapas** (`html[data-boot]`): `identificando → configurando → carregando → pronto` (ou `erro` / `sessao-expirada`), com `data-dados`
  (`carregando | disponivel | erro`). O menu de canais nasce vazio; enquanto a unidade/fontes não chegam só há esqueleto de menu.
- **Fontes em paralelo** com a sessão (na plataforma a unidade é a da sessão). Falha de fontes = erro com "Tentar novamente", nunca SAIPOS por padrão.
- **Telas derivadas das fontes** (`formatar.js#definirFontesDaUnidade`, `telas.js#canalNaUnidade`): canal fora das fontes só aparece se tiver valor/registro (nenhum dinheiro some).
- **Cabeçalho único** com unidade, fontes, competência, links oficiais (`/?setor=operacional`, `/?setor=escolher`) presentes desde a 1ª pintura.
- **Sessão expirada**: 401 → 1 renovação (`refreshSession`) e 1 repetição por chamada (compartilhada e com intervalo mínimo de 20 s); MFA exigido não é "sessão expirada";
  rede (`status 0`), permissão (403) e contexto (409) são estados distintos; ao expirar, consultas em voo são canceladas, cache/estado/painel são limpos e a tela oferece
  *Entrar novamente* (`/?setor=financeiro`), *Voltar à plataforma* e *Dashboard Operacional*.
- **Plataforma**: transição em tela cheia com a mesma estrutura do v2 (cobre o cabeçalho da plataforma), `location.replace`, `?setor=` lido uma vez e **sempre validado pela lista de setores do servidor**.
  Unidade sabidamente no financeiro legado (um booleano por contexto, neste navegador) não recebe a transição em estilo v2.
- **Desempenho**: telas pesadas (`conf`, `can`, `ven`, `adm`, `ent`, calendário/importações de canal) são baixadas sob demanda e aquecidas em tempo ocioso.
- **Telas**: formulário de "Registrar conta a pagar" recolhível (a lista abre na primeira dobra); formulários de ação em colunas; contraste dos títulos do menu; menu recolhível.

## Fase 2 (conclusão)

- **Contrato de fontes corrigido** (`dominio/conferencias.js`, `aplicacao/fontesDeFaturamento.js`): relatórios esperados derivam das fontes reais da unidade e da **vigência histórica**
  (`d.vigenciasDeFontes`, montada do histórico de configuração, só leitura). Regras: sem configuração = padrão histórico (SAIPOS); a primeira configuração gravada vale desde sempre
  (o padrão é valor de partida, não vigência); trocas posteriores valem pela competência (competência que termina antes da troca mantém o sistema antigo). Subway espera SWF 45 e SWF 03
  (equivalentes do faturamento diário e das formas de pagamento do SAIPOS; `FONTE_SEM_DOCUMENTO` segue sem efeito no fechamento). Nenhum valor/DRE/taxa/importação alterado
  (teste compara DRE e Visão Geral antes/depois). Pendências históricas não são apagadas: são derivadas e continuam existindo para competências em que o sistema antigo valia.
  Decisão que fica com o usuário: trocar SAIPOS→SWF numa unidade com competências passadas já fechadas mantém as pendências SAIPOS dessas competências (intencional).
- **Sistema visual** (`fv2.css`): tokens de espaçamento (4 pt) e tipografia, coluna única centralizada (`--largura`), controles de formulário unificados, cabeçalho de tabela,
  estado vazio, feedback de ação (`data-estado`), formulários recolhíveis nas telas de consulta (Contas a Pagar/Receber, Caixa e Bancos), menu móvel em gaveta, ficha de resumo com leitura controlada.

## Não homologado

Teste logado na plataforma real (Fase 4): **não executado**. A produção serve a `main`, sem estas mudanças; a plataforma local usaria o `.env` de produção. Verificação feita só com
plataforma simulada (dados sintéticos) e testes estruturais. Falta, após publicar em ambiente de teste: entrada, `?setor=financeiro`, expiração/renovação real, usuário só-financeiro,
múltiplas unidades, queda de rede, troca de unidade/competência.

## Pendências de contrato do backend (NÃO alteradas — decidir antes)

1. (RESOLVIDO na fase 2) `FONTES_DA_COMPETENCIA` listava relatórios SAIPOS como esperados de toda unidade.
2. O servidor devolve a configuração de fontes sem versão; unidade sem configuração gravada vale o padrão histórico (SAIPOS). Para a Subway isso depende de a configuração da unidade estar gravada em produção.

## Como verificar

```
node --test frontend/test/*.test.js                         # inclui financeiroV2Repaginacao.test.js
FV2_PLAYWRIGHT_PATH=<playwright-core> node backend/scripts/fv2/navegadorRepaginacao.mjs frontend      # Chrome real, plataforma simulada
FV2_PLAYWRIGHT_PATH=<playwright-core> node backend/scripts/fv2/medirRepaginacao.mjs <antes> <depois>  # antes × depois
FV2_PLAYWRIGHT_PATH=<playwright-core> node backend/scripts/fv2/capturarTelas.mjs frontend <pasta> subway
```
Todos usam dados sintéticos em memória e só `127.0.0.1`.

## Homologação final (19/11)

### Contrato de relatórios esperados (commit a563fb0)
- Sistema de loja: só o que vigora na competência (SAIPOS ou SWF 45/03).
- Stone: só com operadora Stone ativa em algum dia da competência. Unicred: só com conta bancária Unicred ativa.
  Valem quando a unidade tem fontes configuradas OU operadoras/contas bancárias cadastradas; unidade sem nada disso mantém o padrão histórico.
- Todos são controles documentais (`FONTE_SEM_DOCUMENTO` → `SEM_EFEITO`): não entram nos impedimentos de homologação (teste dedicado).
- Mudança de comportamento conhecida: unidade com conta bancária que NÃO é Unicred deixa de receber "Falta: Extrato da Unicred" (2 asserções antigas de `conferencias.test.js` ajustadas).

### Configuração lida em produção
Conferida só por leitura em 19/11: a Subway tem as fontes SWF, iFood e 99Food gravadas, e nada falta para a regra. O detalhe (operadoras e contas) fica
fora do repositório, nas evidências privadas.

### Testes
- PostgreSQL LOCAL ISOLADO (servidor próprio, porta 54339, pasta fora do repositório, senhas geradas na hora; nenhum `.env` lido):
  suíte inteira do Financeiro v2 com `FV2_REPOSITORIO=postgres FV2_CONFERIR_CARGA=1`: 711/714 (1 pulado); as 2 falhas eram as asserções antigas de Unicred,
  corrigidas e reexecutadas no Postgres e em memória (conferências + contrato + Subway: 30/30 em cada).
- Frontend: 2058 testes, 0 falhas. Navegador real (plataforma simulada): 71/71.

### Desempenho das leituras de vigência
| Repositório | leituras de vigência | consulta da Central | Visão Geral |
| --- | --- | --- | --- |
| PostgreSQL local isolado | 1,6 ms | 21,9 ms | 22,1 ms |
| Memória | 0,1 ms | 2,8 ms | 4,6 ms |
Mediana de 15 execuções em base sintética pequena; não é tempo de produção (latência de rede do Supabase não incluída: 2 consultas indexadas por carga).

### BLOQUEIOS para a homologação autenticada (itens 4 e 5 — NÃO executados)
1. O projeto de teste (`teste-multiempresarial`, `.env.test-integracao`) não tem o esquema `financeiro_v2`: seria preciso aplicar as 27 migrações nele (migração vetada nesta etapa).
2. Contas de teste e concessões financeiras precisam ser criadas (exige autorização) e a liberação/administração da unidade exige 2º fator (TOTP) de administrador real — não pode ser contornado.
3. A produção serve a `main`, sem estas mudanças.
Portanto entrada, renovação/expiração reais, retorno à plataforma, Dashboard Operacional, permissões e troca de unidade com autenticação real seguem **não homologados**; só há verificação em plataforma simulada.
