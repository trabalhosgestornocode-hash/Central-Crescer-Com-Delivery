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

## Pendências de contrato do backend (NÃO alteradas — decidir antes)

1. `dominio/conferencias.js#FONTES_DA_COMPETENCIA` lista "Faturamento diário do SAIPOS" e "Formas de pagamento do SAIPOS" como relatórios **esperados de toda unidade**.
   A interface os esconde na Subway, mas o servidor deveria derivar os esperados das fontes da unidade (afeta também pendências de fechamento).
2. O servidor devolve a configuração de fontes sem versão; unidade sem configuração gravada vale o padrão histórico (SAIPOS). Para a Subway isso depende de a configuração da unidade estar gravada em produção.

## Como verificar

```
node --test frontend/test/*.test.js                         # inclui financeiroV2Repaginacao.test.js
FV2_PLAYWRIGHT_PATH=<playwright-core> node backend/scripts/fv2/navegadorRepaginacao.mjs frontend      # Chrome real, plataforma simulada
FV2_PLAYWRIGHT_PATH=<playwright-core> node backend/scripts/fv2/medirRepaginacao.mjs <antes> <depois>  # antes × depois
FV2_PLAYWRIGHT_PATH=<playwright-core> node backend/scripts/fv2/capturarTelas.mjs frontend <pasta> subway
```
Todos usam dados sintéticos em memória e só `127.0.0.1`.
