# Financeiro v2 — 20. Documentos, desempenho, acessibilidade e fechamento (Execução 08D)

Data: 14/11/2026. Branch local `feat/financeiro-v2-documentos-desempenho`, derivada de `dc66497` (08C).

> **Homologação técnica SINTÉTICA, não autorização de produção.**
> - Identidades, empresa, unidades, contas, documentos (PDFs gerados para o teste) e valores são fictícios.
> - Tudo em 127.0.0.1, num PostgreSQL 17 próprio e descartável (`fv2-pg-teste`, porta 54329), com gateway sintético
>   e cofre de teste em `%LOCALAPPDATA%\fv2-homologacao\cofre`. Credenciais geradas localmente, fora do Git.
> - Produção não foi acessada; `backend/.env` não foi lido; o financeiro antigo não foi tocado; nada foi publicado
>   (sem push, merge ou deploy).
> - A integração definitiva continua decidida como na 08B (§ 0 do doc 18): login, empresa/unidade e navegação da
>   plataforma; o Financeiro v2 mantém só as permissões por ação e a proteção PostgreSQL.

Commits locais desta execução (sem push):

| Commit | Conteúdo |
|---|---|
| `8a38799` | Parte 1 — envio de evidências pela interface, protocolo cofre→banco, conciliação fraca exige prova do vínculo, fechamentos pré-vigência explicados |
| `b8d8b9e` | Parte 2 — carga dirigida da tesouraria e dos detalhes, índices seletivos (0017), menos contagens, conciliação ambígua, auditor de acessibilidade |
| `c568365` | Parte 3 — registrar conta, pagar (saída + baixa numa transação) e informar saldo pela tela |
| `03ee7a5` | Achado da jornada no navegador — a pendência "Despesa sem classificação" passa a mostrar os documentos já vinculados |
| (este) | EXPLAIN no gerador de desempenho + este documento |

---

## 1. Diagnóstico inicial (Fase A)

Linha de base em `dc66497`:
- suíte do núcleo: 324/324 em memória e em PostgreSQL;
- frontend: 1935 testes passando, 0 falhas.

| # | Problema herdado da 08C | Gravidade | Situação ao fim da 08D |
|---|---|---|---|
| A1 | Sem envio de documento pela interface: a evidência precisava já estar no cofre | Alta | **Resolvido** (§ 2) |
| A2 | Reclassificação com documento só por evidência pré-carregada | Média | **Resolvido**: o documento é enviado pela tela e usado na reclassificação (§ 4) |
| A3 | Visão Geral, Caixa, Contas a Receber e os detalhes de venda e recebível liam mais que a competência | Média | **Resolvido em parte**: os detalhes são dirigidos; as telas de posição ficam lineares por natureza (§ 5, § 8) |
| A4 | O planejador sem estatísticas ignorava os índices da 0015 | Média | **Resolvido**: os índices da 0017 começam pela coluna seletiva (§ 7) |
| A5 | Três fechamentos recusados no gerador, sem causa investigada | Baixa | **Explicado**: bloqueio esperado, anterior à vigência da metodologia; teste de regressão (§ 9) |
| A6 | Conciliação ambígua provada só na suíte | Média | **Resolvido**: 10 passos no navegador (§ 10) |
| A7 | Interface sem auditoria sistemática de acessibilidade; Tab completo e leitor de tela não verificados | Média | **Resolvido em parte**: auditor automático + teclado real; leitor de tela **NÃO TESTADO** (§ 11) |
| A8 | Jornada completa dependia de operações fora da tela (registrar conta, pagar, informar saldo) | Alta | **Resolvido**: formulários novos (§ 12) |
| A9 | Item 9 da recuperação (08C) usava a finalidade `baixar`, mas o enum é `BAIXAR`: o hash do arquivo nunca era lido | Média | **Corrigido** no roteiro e no teste |

---

## 2. Envio documental (Fase B)

Fluxo pela tela:
1. Central → Pendência → **Adicionar documento**.
2. Escolher o arquivo, o tipo e a finalidade; marcar a confirmação.
3. O serviço valida, guarda no cofre e confere a releitura.
4. Grava a ficha e o vínculo numa transação.
5. A pendência é reavaliada.

O formulário também aparece no detalhe de uma **correspondência**, para provar um vínculo de conciliação.

| Peça | Arquivo | Papel |
|---|---|---|
| Regras de formato | `dominio/evidencias.js` | PDF, PNG e JPEG: tipo MIME, extensão e assinatura binária precisam concordar. Limite de 10 MiB. Nome reduzido a um nome seguro (sem caminho nem caracteres de controle, até 100 caracteres). PDF com `/JavaScript`, `/OpenAction`, `/Launch` e similares é marcado como **conteúdo ativo**: guardado, mas nunca exibido inline. |
| Caso de uso | `aplicacao/evidencias.js` (`enviarEvidencia`) | Exige `enviar_documento`, mostrado a seguir. |
| Conferência do cofre | `conferirCofreDocumental` | Arquivos sem ficha e fichas sem arquivo, com permissão `documentos`. |
| Barreira no banco | `0016_envio_de_evidencias.sql` | Ação `enviar_documento` no catálogo; `fv2_documento_incluir`, `fv2_vinculo_documental_incluir` e `fv2_historico_incluir` a aceitam. |
| Rota sintética | `POST /api/fv2/acoes/documentos/enviar` | Exige CSRF, mesma origem e JSON estrito. Base64 estrito, corpo até 15 MB só nesta rota (8 KiB nas demais). Campo desconhecido → 400. |
| Interface | `telasConferencias.js` (`formularioDeEvidencia`) | Rótulos, região de anúncio e anúncio da escolha do arquivo; leitura em base64 em `app.js`. |

O caso de uso `enviarEvidencia`, em ordem:
1. exige `enviar_documento` no escopo da unidade;
2. confere que o registro-alvo existe;
3. `cofre.guardar`, depois `cofre.ler` e comparação do SHA-256;
4. numa transação: reconfere o alvo e `cofre.existe`, reaproveita o documento de mesma chave `sha256:<hash>` ou cria a ficha, e cria o vínculo com chave idempotente;
5. devolve `repetido` / `documentoReaproveitado` e o efeito. **Não** resolve a pendência.

**Anexar não resolve a pendência sozinho.** Uma classificação provisória continua aberta até a decisão de reclassificar.
Já a pendência "Conta sem comprovante" deixa de existir com o documento, porque o documento é o que ela pede.

---

## 3. Segurança do cofre

| Exigência | Como é garantida | Prova |
|---|---|---|
| Permissão explícita | `enviar_documento` no núcleo **e** no banco (0016); operador e gestor recebem 403 | `evidencias.test.js` ("permissão, escopo e separação"), barreira PG; frontend 403 |
| CSRF / origem | Token por sessão; origem diferente → 403; sem token → 403 | `financeiroV2Evidencias.test.js` |
| Escopo | Alvo de outra unidade não é encontrado (nem existe para o chamador) | suíte |
| Tamanho, conteúdo e extensão | MIME × extensão × assinatura; 10 MiB; base64 estrito | "formatos e nomes hostis" (PDF falso, PNG com extensão .pdf, executável renomeado, vazio, acima do limite) → 422 |
| Nome não confiável | O nome é só rótulo: basename, sem controle, 100 caracteres; nunca vira caminho | `../../etc/passwd`, `C:\x`, nomes com NUL e RTL testados |
| Path traversal | O arquivo no cofre é endereçado pelo hash, nunca pelo nome | idem; a resposta nunca devolve caminho nem id interno do cofre |
| Integridade | SHA-256 na gravação, releitura antes de gravar a ficha, "Verificar integridade" pela tela | navegador: "Arquivo integridade verificada (íntegro)" no histórico |
| Imutabilidade | Correção = nova versão (a anterior fica "substituída"); vínculos e histórico só recebem inclusões | suíte da 06D/07 |
| Deduplicação | Mesmo conteúdo → mesmo documento, novo vínculo | navegador: o mesmo PDF enviado na conta e no lançamento gerou **1 documento com 2 vínculos** |
| Ids opacos / sem URL pública | Navegador vê `ref-…`; arquivo só por rota autenticada | rota de visualização apenas para PDF sem conteúdo ativo |
| Auditoria | Histórico do documento + auditoria integrada (07) | navegador e suíte |
| Atomicidade cofre ⇄ banco | Gravação em duas fases (`temporarios/g-<hex>` → `link` para o caminho final → apaga o temporário). A ficha só é gravada depois de o arquivo existir e ser relido. Queda entre cofre e banco deixa arquivo **sem ficha**, nunca ficha sem arquivo; o reenvio reaproveita o arquivo; temporários com mais de 15 min são limpos | "falha entre cofre e banco", "duas fases e limpeza de temporários" |
| Nunca apagar evidência | Nenhuma rota de exclusão; `arquivosSemFicha` é relatado, não apagado | `conferirCofreDocumental` |

---

## 4. Jornada de reclassificação (Fase C), pelo navegador

Ambiente:
- banco de homologação isolado `fv2_teste_homologacao_3c74b01b`;
- login do administrador sintético com segundo fator;
- unidade "Demonstração (Saci)", competência outubro de 2026.

1. **Contas a pagar → Registrar conta a pagar**: "Gráfica Sintética", R$ 240,00, categoria *Despesas a classificar*.
   A conta aparece como "Aguardando classificação · Pendência fora da DRE até classificar".
2. **Central → Pendência "Despesa sem classificação" (R$ 240,00) → Adicionar documento**: `nf-grafica-cardapios.pdf`
   (sintético) → guardado no cofre.
   - **Achado:** a pendência continuava mostrando "Nenhum documento vinculado". O detalhe da pendência de despesa
     não montava os documentos do lançamento nem da conta.
   - **Correção** em `dominio/conferencias.js` (commit `03ee7a5`), só de leitura: nenhuma regra nem o núcleo mudou.
   - **Teste de regressão:** agora a pendência lista a NF e **continua aberta**.
3. O mesmo para o boleto de R$ 189,90 com `nf-contabilidade-outubro.pdf`.
4. **Revisar e reclassificar o lançamento** → nova categoria *Despesas administrativas gerais* → **prévia** ("nada foi
   gravado"):
   - DRE: −R$ 3.447,30 → −R$ 3.637,20;
   - "Reclassificar não movimenta dinheiro";
   - impedimentos 1 → 1.
   Depois: confirmação com justificativa → "categoria confirmada".
5. Conta de R$ 240,00: prévia com impedimentos 1 → **0**, despesas −R$ 3.637,20 → −R$ 3.877,20; confirmada.
6. Envio do **mesmo** PDF pela pendência "Conta sem comprovante" de cada conta:
   - o documento foi **reaproveitado** (a lista de documentos continuou com uma única ficha por NF);
   - o vínculo com a conta foi criado;
   - a pendência documental desapareceu.

---

## 5. Consultas otimizadas (Fases D e E)

| Tela | Antes (08C) | Agora |
|---|---|---|
| Caixa, Fluxo, Calendário, Visão Geral (`carregarTesouraria`) | Carga completa | Completas só as tabelas de posição (contas, saldos, movimentações, obrigações, recebíveis, liquidações, ajustes, documentos, vínculos). Dirigidos: lançamentos (pelas obrigações e ajustes), pagamentos (pela movimentação), propostas (`MOVIMENTACAO_BANCARIA`) e conciliações (só `DIVERGENTE`) |
| Detalhe de venda e de recebível | Carga completa | `carregarDaCompetencia([competência do registro])` |
| Detalhes de conta a pagar e a receber | Carga completa | Carregadores dirigidos da 07B |
| Paginação interna da carga dirigida | `count(*)` por página | `contar: false` na porta: sem contagem (total `null`) |
| Índices | 0015 `(organizacao_id, unidade_id, coluna)` | 0017 `(coluna seletiva, organizacao_id, unidade_id)` — ver § 7 |

Toda tela otimizada tem **modo de conferência** (`FV2_CONFERIR_CARGA=1`). Cada consulta é calculada também com a carga
completa e comparada (`exigirEquivalencia`); qualquer diferença vira erro.

**Consultas e linhas por tela** (12 meses, unidade grande; `c` = consultas, `l` = linhas lidas):

| Tela | Dirigida | Completa |
|---|---|---|
| Visão Geral / Caixa / Fluxo | 31c / 10.826 l | 18c / 19.706 l |
| Contas a receber | 70c / 7.866 l | 18c / 19.706 l |
| Contas a pagar / detalhe | 17–18c / ~1.527 l | 18–19c / ~19.707 l |
| Detalhe de venda / recebível | 76c / 4.304 l | 23c / 24.987 l |
| Vendas / Recebimentos | 74c / 4.303 l | 21c / 24.986 l |
| Central / Pendências / Fechamento / Prévia | 74–77c / ~4.304 l | 23–26c / ~24.998 l |
| Unidade pequena (Central / Vendas) | 32–35c / 172 l | 21–26c / 132 l |

A carga dirigida faz **mais consultas** (o fecho por ids é feito em lotes), mas lê **5,8× menos linhas** nas telas de
competência (23× menos em 48 meses: 4.591 × 100.058). Na unidade pequena, que lê quase nada, as consultas a mais
custam ~8 ms (§ 8).

---

## 6. Equivalência financeira

- **Gerador** (12 e 48 meses): para **cada** competência, 6 telas (central, pendências, fechamento, vendas,
  recebimentos, divergências) dirigida = completa. Resultado: **12/12 e 48/48 meses IDÊNTICOS**. As 16 telas medidas antes/depois foram comparadas
  campo a campo: todas `IDENTICO`.
- **Suíte em modo de conferência**: toda a suíte do núcleo roda com `FV2_CONFERIR_CARGA=1` em memória e em
  PostgreSQL (resultados no § 12). Qualquer divergência entre a carga dirigida e a completa reprovaria o teste que a
  provocou.
- **Navegador**: a DRE de outubro bateu com um razão independente escrito à mão antes da jornada (§ 12, passo 14).

---

## 7. Estatísticas PostgreSQL

- **0017** recria os índices com a coluna **seletiva primeiro**:
  - competência: venda, lançamento, recebível, obrigação, ajuste, proposta, `registro_fonte`;
  - data efetiva: movimentação, liquidação, estorno;
  - chaves do fecho: `venda_id`, `grupo_id`, `pagamento_id`, `alvo_id`, `movimentacao_id`, `registro_id`, `origem->>'id'`, `origem->>'vendaId'`.

  Com estatísticas, o EXPLAIN mostra **todas** as consultas pesadas da Central usando esses índices (§ 7.1).
- **Com × sem estatísticas** (12 meses; o modo "sem" desliga o autovacuum nas tabelas antes da carga e não roda
  `ANALYZE`).
  - Sem estatísticas, **parte** das consultas ainda usa índices de competência ou de chave do fecho (lançamento por
    competência, vínculo documental, ajuste por alvo).
  - Outras (venda, pagamento, recebível, lançamento por lista de ids) caem no índice da chave
    `(organizacao_id, unidade_id, id)` e leem a unidade inteira: 3,6 mil a 6,5 mil blocos, contra 26 a 181.
  - Mesmo assim, as telas ficam só 0–30 ms mais lentas (§ 8), contra o dobro ou mais na 08C, porque cada consulta
    continua em 2–5 ms neste volume.
  - A dependência de `ANALYZE` caiu de "crítica" para "importante": o § 7.2 continua obrigatório na infraestrutura
    real, sobretudo depois de cargas grandes.
- **Unidades desiguais**: o mesmo banco tem uma unidade com 12 meses (~25 mil linhas) e outra com 20 vendas. A tela
  da unidade pequena fica em 26–29 ms com 12 **e** com 48 meses da grande: o custo não vaza entre unidades.
- **EXPLAIN (ANALYZE, BUFFERS)** das consultas reais da Central: ver § 7.1.

### 7.1 EXPLAIN das consultas da Central

Método (`scripts/fv2-desempenho.mjs`, 12 meses, unidade grande):
- o SQL e os parâmetros **reais** emitidos pelo adaptador durante uma chamada da Central dirigida são capturados no
  driver;
- as 8 consultas que mais tempo somaram na tela passam por `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, como dono.

A RLS não entra no plano: ela só acrescenta o filtro de escopo. As 16 telas continuaram `IDENTICO` e as 12
competências equivalentes nas duas rodadas.

**Com estatísticas (`ANALYZE`):**

| Tabela (filtro, pelo índice usado) | Plano | Execução | Blocos | Linhas |
|---|---|---|---|---|
| `fv2_lancamento` (origem: id) | Bitmap Index Scan `fv2_lancamento_origem_id_sel` | 3,0 ms | 181 | 200 |
| `fv2_lancamento` (competência) | Bitmap Index Scan `fv2_lancamento_competencia_sel` | 1,5 ms | 26 | 500 |
| `fv2_lancamento` (origem: venda) | Index Scan `fv2_lancamento_origem_venda_sel` | 0,1 ms | 2 | 0 |
| `fv2_venda` (competência) | Bitmap Index Scan `fv2_venda_competencia_sel` | 1,6 ms | 36 | 400 |
| `fv2_recebivel` (venda) | Bitmap Index Scan `fv2_recebivel_venda_sel` | 0,7 ms | 91 | 150 |
| `fv2_pagamento_venda` (venda) | Bitmap Index Scan `fv2_pagamento_venda_venda_sel` | 1,0 ms | 106 | 200 |
| `fv2_movimentacao` (pagamento) | Bitmap Index Scan `fv2_movimentacao_pagamento_sel` | 0,3 ms | 29 | 50 |
| `fv2_vinculo_documental` (registro) | Seq Scan (tabela quase vazia neste cenário) | 0,03 ms | 0 | 0 |

**Sem estatísticas:**

| Tabela (consulta capturada) | Plano | Execução | Blocos | Linhas |
|---|---|---|---|---|
| `fv2_lancamento` (consulta 1) | Index Scan `fv2_lancamento_competencia` | 5,1 ms | 291 | 200 |
| `fv2_lancamento` (consulta 2) | Index Scan da chave `(organizacao_id, unidade_id, id)` | 4,1 ms | **6.528** | 500 |
| `fv2_pagamento_venda` | Index Scan da chave | 2,5 ms | **4.818** | 200 |
| `fv2_recebivel` | Index Scan da chave | 2,1 ms | **3.634** | 150 |
| `fv2_venda` | Index Scan da chave | 4,4 ms | **4.847** | 400 |
| `fv2_vinculo_documental` | Index Scan `fv2_vinculo_documental_registro_sel` | 0,05 ms | 2 | 0 |
| `fv2_ajuste` | Index Scan `fv2_ajuste_alvo` | 0,4 ms | 58 | 80 |

Leitura:
- **Com** estatísticas, os índices seletivos são usados e cada consulta lê dezenas a poucas centenas de blocos.
- **Sem** estatísticas, o planejador às vezes prefere percorrer a unidade pela chave, porque a ordenação já vem
  pronta (`order by id`). Lê 25–180× mais blocos e o resultado é o mesmo.
- O planejamento custa ~2–3,7 ms por consulta. Com ~75 consultas por tela, isso pesa (§ 14).

### 7.2 Procedimento de ANALYZE (para a infraestrutura real)

1. Depois de uma migração, de uma carga inicial ou de uma importação grande (meses retroativos), rodar como dono:
   `ANALYZE fv2_venda, fv2_lancamento, fv2_recebivel, fv2_obrigacao, fv2_movimentacao, fv2_liquidacao, fv2_pagamento_venda, fv2_registro_fonte, fv2_vinculo_documental;`
   (ou `ANALYZE;` no banco do financeiro).
2. Manter o autovacuum **ligado** (padrão). Para tabelas que crescem em lote, considerar
   `autovacuum_analyze_scale_factor = 0.02` nas tabelas acima.
3. Conferir: `select relname, last_analyze, last_autoanalyze, n_mod_since_analyze from pg_stat_user_tables where relname like 'fv2\_%' order by n_mod_since_analyze desc;`
   Valores altos de `n_mod_since_analyze` pedem `ANALYZE`.
4. Não é pré-requisito de correção: sem estatísticas os resultados são os mesmos, só um pouco mais lentos (§ 8).

Nada disso foi executado fora do PostgreSQL isolado.

---

## 8. Desempenho antes/depois (Fase J)

Medianas de 5 execuções, PostgreSQL 17 local (`fsync` desligado no ambiente de teste), dados sintéticos.
- "Antes" = carga completa, como na 08C.
- "Depois" = carga dirigida 08D.
- 12 meses = 4.800 vendas, 6.480 lançamentos, 3.600 recebíveis, 1.472 movimentações.
- 48 meses = 4× o volume (19.200 vendas, 25.920 lançamentos).

| Tela | 12m antes → depois | 12m sem estatísticas (depois) | 48m antes → depois |
|---|---|---|---|
| Visão Geral | 302 → 190 ms | 205 ms | 1187 → 745 ms |
| Caixa e bancos | 272 → 161 ms | 183 ms | 1011 → 607 ms |
| Fluxo de caixa | 271 → 166 ms | 185 ms | 1026 → 628 ms |
| Contas a receber | 278 → 173 ms | 186 ms | 1039 → 728 ms |
| Contas a pagar | 266 → 37 ms | 41 ms | 1034 → 129 ms |
| Detalhe de venda | 422 → 153 ms | 183 ms | 1658 → 209 ms |
| Detalhe de recebível | 417 → 153 ms | 175 ms | 1631 → 210 ms |
| Detalhe de conta a pagar | 261 → 37 ms | 40 ms | 1007 → 129 ms |
| Vendas | 419 → 157 ms | 181 ms | 1621 → 218 ms |
| Recebimentos | 414 → 161 ms | 193 ms | 1649 → 217 ms |
| Central de Conferências | 454 → 170 ms | 195 ms | 1764 → 230 ms |
| Pendências | 449 → 172 ms | 188 ms | 1828 → 220 ms |
| Fechamento | 464 → 182 ms | 185 ms | 1818 → 226 ms |
| Prévia de homologação | 368 → 154 ms | 175 ms | 1405 → 210 ms |
| Central — unidade pequena | 20 → 28 ms | 28 ms | 20 → 29 ms |
| Vendas — unidade pequena | 17 → 29 ms | 26 ms | 17 → 26 ms |

Outras medições:
- DRE do mês: 38 ms (12m).
- Composição de um indicador: 34 ms.
- 10 apurações simultâneas: 399 ms.
- 10 telas mistas simultâneas: 814 ms (12m) e 1787 ms (48m).
- Memória do processo em 48 meses: RSS 494 MB, heap 406 MB.

Leitura:
- **Telas de competência** (Vendas, Recebimentos, Central, Pendências, Fechamento, Prévia, detalhes): com 4× o
  volume, 153–182 → 209–230 ms. É quase constante: lê a competência e o fecho, não o histórico.
- **Telas de posição** (Visão Geral, Caixa, Fluxo, Contas a receber): 1,6× mais rápidas, mas ainda **lineares no
  histórico**. A posição numa data soma todo o passado das contas, obrigações e recebíveis. O próximo passo seria
  um saldo materializado por conta/mês (fato de fechamento), fora do escopo desta execução.
- **Unidade pequena**: +8–12 ms pelas consultas a mais do fecho. É um custo fixo pequeno, aceito.
- A memória cresce com o histórico porque o gerador mantém tudo no mesmo processo (núcleo "antes" + "depois" +
  perfil). Não é medida de produção.

---

## 9. Fechamentos recusados e causas (Fase F)

O gerador recusava 3 fechamentos com `TRANSICAO_INVALIDA`. O diagnóstico por mês e por etapa
(`diagnosticoFechamentos`) mostrou a causa:
- as competências **2025-10, 2025-11 e 2025-12** são **anteriores à vigência da metodologia** (2026-01);
- o núcleo recusa com "Não há metodologia vigente publicada". É o comportamento correto.

O gerador agora as marca como `esperado`. Em 48 meses, todos os meses anteriores a 2026 aparecem como `esperado` e
nenhum outro é recusado. Teste de regressão: `metodologia-vigencia.test.js`:
- o preliminar de 2025-10..12 é recusado com "metodologia vigente";
- o de 2026-01 é aceito.

Nenhuma regra foi afrouxada.

---

## 10. Conciliação ambígua (Fase G), pelo navegador

Catálogo sintético novo:
- `pedidos-saipos-0510-ambiguo`: DEMO-A1 às 12:00 e DEMO-A2 às 12:06, ambos R$ 42,00 no débito;
- `stone-0510-ambiguo`: DEMO-SA1 às 12:03, R$ 42,00, sem código de autorização.

1. Importar os dois arquivos pela tela (prévia → confirmar).
2. Gerar candidatas: duas candidatas para a mesma transação Stone.
3. A2 aparece como **ambígua**, sem botão de confirmar; o motivo é exibido.
4. POST forçado de confirmação da A2 → **409** "Correspondência ambígua…".
5. A1 **recusada** com motivo, pela tela.
6. A2 continua FRACA: sem justificativa **e** sem documento do vínculo, não confirma.
7. **Comprovante da maquininha** (PDF sintético, NSU 000123) enviado pelo formulário da correspondência.
8. "Documentos que provam o vínculo" lista o comprovante.
9. Confirmar com justificativa → **Confirmada**; histórico Candidata → Confirmada.
10. Repetir a confirmação → **409** "Esta correspondência já foi decidida".

Regra endurecida nesta execução: uma correspondência FRACA exige justificativa **e** evidência específica do vínculo
(documento na decisão ou vínculo documental na correspondência). Relatórios de origem não contam como prova do
vínculo. Quatro testes antigos que confirmavam FRACA sem prova foram atualizados para enviar a prova.

---

## 11. Acessibilidade (Fase H)

**Auditor próprio** (`frontend/test/acessibilidade/auditoria.js`, sem dependências). As mesmas regras rodam sobre o
HTML gerado no Node e sobre o DOM real no navegador:
- campos sem rótulo;
- botões e links sem nome; imagens sem `alt`;
- tabelas sem legenda ou sem `<th>`; `<th>` de cabeçalho sem `scope`;
- `tabindex` positivo; ids duplicados; `aria-labelledby`/`describedby` quebrados;
- diálogo sem título;
- formulário de ação sem região de anúncio.

| Verificação | Resultado |
|---|---|
| Controle positivo (defeitos plantados no DOM real) | Os 4 defeitos plantados foram detectados |
| 10 rotas + 6 seções da Central no DOM real (desktop) | **0 problemas** |
| Painéis: pendência, correspondência, proposta, documento, venda, conta a pagar, importação | **0 problemas** |
| Formulários críticos no Node (envio, reclassificação, conciliação, fechamento, registrar conta, pagar, informar saldo) | **0 problemas** (`financeiroV2Acessibilidade`, `financeiroV2Evidencias`, `financeiroV2Operacoes`) |
| Teclado real (teclas enviadas ao navegador) | Enter abre o detalhe. O foco vai para o diálogo (`aria-modal="true"`, título por `aria-labelledby`). Tab percorre os campos dentro do painel. Esc fecha e o foco **volta ao botão de origem** |
| Painel fechado | O contêiner fica `hidden`: sai da árvore de acessibilidade |
| Celular (375 px) | 8 telas sem rolagem horizontal (`scrollWidth = 375`) e 0 problemas |
| **Leitor de tela real (NVDA/Narrador/VoiceOver)** | **NÃO TESTADO** — nenhum leitor de tela foi executado nesta execução |
| Contraste de cores e ordem visual × DOM | **NÃO TESTADO** (fora do alcance do auditor) |

---

## 12. Testes e regressões (Fases I e K)

### 12.1 Jornada full stack de 20 passos, pelo navegador

Pilha completa:
- aplicação em 127.0.0.1:5181, gateway sintético em processo separado (5182);
- PostgreSQL isolado com RLS e sessões de banco;
- cofre em disco.

Todas as ações foram feitas pela interface. As tabelas não foram alteradas à mão. O serviço foi reiniciado uma vez
(para carregar a correção do passo 9) e o banco foi reaproveitado.

**Razão independente**, escrito antes de cada passo:
- linha de base: despesas −R$ 3.447,30;
- vendas aplicadas: +R$ 83,00 (28 + 36 + 19);
- reclassificações: −R$ 189,90 e −R$ 240,00;
- esperado: faturamento R$ 83,00, despesas −R$ 3.877,20, resultado −R$ 3.794,20.

| # | Passo | Resultado |
|---|---|---|
| 1 | Autenticar | Administrador sintético com segundo fator |
| 2 | Selecionar unidade | "Demonstração (Saci)", outubro de 2026 |
| 3–5 | Importar, conferir a prévia, confirmar | SAIPOS 01/10: prévia com 3 válidos (R$ 83,00), confirmada; também Stone 01/10 e os arquivos ambíguos de 05/10 |
| 6–7 | Aprovar e aplicar propostas | Aplicadas: R$ 28, R$ 36, R$ 19 |
| 8 | Registrar obrigação | Gráfica Sintética, R$ 240,00, "a classificar" |
| 9 | Enviar evidência | 2 NFs pela pendência; achado e correção (§ 4) |
| 10 | Reclassificar | 2 lançamentos → Despesas administrativas gerais, com prévia e justificativa |
| 11 | Conciliar recebimento | Candidata forte SAIPOS × Stone (R$ 36, AUT-DEMO-O2) confirmada; ambígua (§ 10); energia R$ 618,50 confirmada com comprovante |
| 12 | Conferir saldos | Saldo informado do extrato em 31/10 = R$ 20.045,40; calculado R$ 20.045,40; diferença R$ 0,00, "confere" |
| 13 | Conferir fluxo | 18.123,50 + 2.171,90 = 20.295,40 = banco 20.045,40 + caixa 250,00 |
| 14 | Conferir DRE | Faturamento **R$ 83,00**, despesas **R$ 3.877,20**, resultado **−R$ 3.794,20**: igual ao razão independente |
| 15 | Resolver impedimentos | Pendências 13 → 8, todas as que eram resolvíveis com dados sintéticos legítimos; 0 bloqueiam |
| 16 | Homologar | Preliminar (v1) → **homologado (v2)**; ver achado F-1 |
| 17 | Fato posterior | Conta de outubro paga em 10/11 pela tela (saída + baixa juntas); DRE homologada inalterada. Registrar conta nova em outubro → **recusado** ("A competência está homologada…") |
| 18 | Reabrir | Com justificativa; "Revisões 1" |
| 19 | Homologar de novo | Preliminar (v3) → com pendências documentadas (v4, com a documentação faltante e a decisão) → homologado (v5) |
| 20 | Reproduzir a versão anterior | As 5 versões têm a mesma impressão `5c0d4eb5…`; "A apuração atual reproduz exatamente esta versão"; a v2 é reproduzida pela apuração atual |

**Achados da jornada:**
- **F-1 — Homologação direta do preliminar com pendências "exige documentação" não documentadas.** O domínio permite
  PRELIMINAR → HOMOLOGADO (`dominio/fechamento.js`) e só recusa quando há **impedimento**. A tela dizia "7
  pendências precisam estar documentadas", mas a homologação foi aceita sem passar por "com pendências documentadas".
  Tornar obrigatória essa etapa é uma **decisão de política** (pendente do responsável). Não foi alterada aqui, para
  não mudar critérios do núcleo durante a homologação.
- **F-2 — Conciliar conta × saída bancária não dá baixa na conta.** Depois de confirmar a correspondência da energia,
  a saída de R$ 618,50 continua "sem classificação". O formulário "Registrar pagamento" criaria uma **segunda**
  saída. Falta uma ação de interface "baixar a conta com um movimento já existente" (o núcleo tem
  `registrarLiquidacao` com `movimentacaoId`). Ficou documentada no fechamento.
- **F-3 — Detalhe da pendência de despesa sem os documentos:** corrigido (`03ee7a5`, § 4).
- **F-4 — Linha zerada mostrada com 0,01% no demonstrativo da DRE** (distribuição por maior resto quando o resultado
  é prejuízo grande). É apresentação: os valores estão certos. Fica como risco menor.
- Sem efeito na homologação: duas "vendas sem pagamento correspondente" (R$ 36 e R$ 19) referentes às vendas das
  propostas SAIPOS aplicadas. Não bloqueiam e ficaram documentadas na versão 4. A causa exata **não foi investigada**
  nesta execução.

### 12.2 Suítes

| Suíte | Linha de base (`dc66497`) | 08D (HEAD) |
|---|---|---|
| Núcleo em memória | 324/324 | **332/332** |
| Núcleo em PostgreSQL isolado (migrações até 0017) | 324/324 | **332/332** |
| Núcleo em memória, modo de conferência (`FV2_CONFERIR_CARGA=1`) | 324/324 | **332/332** |
| Núcleo em PostgreSQL, modo de conferência | 324/324 | **332/332** |
| Frontend (`frontend/test/*.test.js`) | 1935 passando, 0 falhas | **1942 passando, 0 falhas** (1968 testes, 26 pulados) |

Testes novos:
- `evidencias.test.js`: 7 testes, em memória e em PG;
- `metodologia-vigencia.test.js`: 2 testes;
- `financeiroV2Evidencias`, `financeiroV2Acessibilidade` e `financeiroV2Operacoes`: 3 + 3 + 1 testes.

Atualizados:
- 4 confirmações FRACA passaram a enviar a prova do vínculo;
- o limite de corpo por rota.

Nenhum teste foi removido ou afrouxado.

### 12.3 Regressão do backend (worktrees limpos, env fictício)

Execução:
- `node --experimental-vm-modules --test test/*.test.js` em dois worktrees limpos (`dc66497` e `03ee7a5`);
- `node_modules` por junction;
- `SUPABASE_URL=http://127.0.0.1:9` e chaves fictícias de 40 caracteres, sem `.env`.

| | Base `dc66497` | HEAD `03ee7a5` |
|---|---|---|
| Testes | 6469 | 6469 |
| Passando | 6427 | 6427 |
| Falhas | 16 | 16 |
| Cancelados | 1 | 1 |

A lista de falhas é **idêntica** (11 entradas, `comm` sem diferenças). São todas pré-existentes e fora do
Financeiro v2:
- central de conversas;
- `checklist-operacional-service` (timeout);
- migrações 088/103;
- "distribuições recompõem mês…";
- "selecionarPerfil".

**Nenhuma regressão.**

---

## 13. Matriz de homologação atualizada (18 domínios)

| # | Domínio | 08C | Alterações e evidências na 08D | 08D | Pendências |
|---|---|---|---|---|---|
| 1 | Segurança por ação | PASS | `enviar_documento` no núcleo e no banco (0016); CSRF/origem; operador/gestor 403 | **PASS** | — |
| 2 | Isolamento entre unidades | PASS | Alvo de outra unidade inexistente para o envio; unidade pequena não paga pelo histórico da grande | **PASS** | — |
| 3 | Gateway sintético | PASS (sintético) | Usado na jornada de 20 passos (segundo fator) | **PASS (sintético)** | Autenticação real é dependência externa |
| 4 | Provisionamento sintético | PASS | Sem mudança | **PASS** | — |
| 5 | Integridade de vendas | PASS | Detalhe de venda dirigido, equivalente | **PASS** | — |
| 6 | Recebíveis | PASS | Detalhe de recebível e Contas a receber dirigidos, equivalentes | **PASS** | — |
| 7 | Obrigações | PASS | Registrar e pagar pela tela (saída + baixa atômicas, idempotente, sem pagar além do saldo) | **PASS** | F-2: baixa com movimento existente sem tela |
| 8 | Tesouraria | PASS | Carga dirigida; saldo informado = calculado pela tela | **PASS** | — |
| 9 | Importações | PASS | Importação ambígua pela tela | **PASS** | — |
| 10 | Conciliações | PASS | Ambígua em 10 passos no navegador; FRACA exige prova do vínculo | **PASS** | — |
| 11 | DRE | PASS | Bate com o razão independente; versão reproduzível | **PASS** | F-4 (apresentação) |
| 12 | Documentos | PASS (sem envio) | Envio pela interface, validação, duas fases, deduplicação, integridade pela tela | **PASS** | Cofre real é dependência externa |
| 13 | Fechamento | PASS | Ciclo completo com reabertura e re-homologação; pré-vigência explicada | **PASS com ressalva** | F-1: política de "documentar antes de homologar" a decidir |
| 14 | Concorrência | PASS | Envio idempotente; pagamento repetido não duplica | **PASS** | — |
| 15 | Recuperação | PASS | Queda entre cofre e banco; temporários; finalidade `BAIXAR` corrigida | **PASS** | Produção depende da infraestrutura real |
| 16 | Interface operacional | PARCIAL | Jornada inteira pela tela; auditor 0 problemas; teclado real; celular | **PARCIAL** | Leitor de tela real **NÃO TESTADO**; contraste não medido |
| 17 | Desempenho | PARCIAL | Competência quase constante em 4×; equivalência total; índices robustos sem estatísticas | **PARCIAL** | Telas de posição ainda lineares no histórico (§ 8) |
| 18 | Plano de integração | PASS (doc) / BLOQUEADO | Decisão mantida | **PASS (doc) / BLOQUEADO POR DEPENDÊNCIA EXTERNA** | § 15 |

---

## 14. Riscos remanescentes

- **F-1 (política):** homologar direto do preliminar com pendências que "exigem documentação" é aceito.
- **F-2 (interface):** falta "baixar conta com movimento existente". O atalho "Registrar pagamento" duplicaria a saída.
- **Desempenho das telas de posição:** linear no histórico (48 meses ≈ 0,6–0,75 s neste computador).
- **Carga dirigida faz mais consultas** (≈ 75 contra ≈ 23). Com latência de rede real entre a aplicação e o banco,
  isso pesa mais que aqui (loopback). Convém medir no ambiente real antes de liberar.
- **Sem estatísticas**, parte das consultas percorre a unidade inteira pela chave (EXPLAIN, § 7.1): `ANALYZE` após
  cargas grandes continua necessário. O planejamento custa ~2–3 ms por consulta, multiplicado pelas ~75 consultas
  da carga dirigida.
- **Leitor de tela real e contraste não verificados.**
- **Conteúdo ativo em PDF** é só detectado e bloqueado na visualização. Não há antivírus nem saneamento: o cofre
  real deve ter varredura.
- **F-4:** 0,01% exibido em linha zerada da DRE com prejuízo grande.
- O ambiente de teste roda com `fsync` desligado: tempos e recuperação não valem como medida de produção.
- Tudo aqui é sintético: nada disso autoriza produção.

## 15. Dependências para a integração real

1. Login da plataforma com nível de autenticação (`aal`) confiável e revogação de contexto (o gateway é sintético).
2. Onde roda a credencial da autoridade de banco (`fv2_autoridade`), fora do processo da aplicação.
3. Infraestrutura PostgreSQL de produção: conexão direta, papéis, durabilidade (`fsync`/`synchronous_commit` ligados),
   autovacuum e o procedimento do § 7.2, backup.
4. **Cofre real** de documentos (armazenamento, varredura de malware, retenção). O envio pela interface e o protocolo
   cofre→banco já existem.
5. Decisões de política:
   - F-1 (documentar antes de homologar);
   - materialidade;
   - retenção;
   - quem recebe `enviar_documento`, `reclassificar` e `reabrir`.
6. Ação de interface para a baixa com movimento existente (F-2), se a operação real conciliar contas pelo extrato.
7. Documentos financeiros reais e homologação de setembro real (fora desta execução por regra).
8. Teste com leitor de tela real por uma pessoa usuária.
