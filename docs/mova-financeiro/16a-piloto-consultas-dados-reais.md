# MOVA — Execução 16A: piloto de consultas com dados financeiros reais

Situação: **preparado e testado localmente**. Nada foi aplicado em produção, nada foi enviado pelo WhatsApp e nenhuma chamada paga foi feita. Cada passo de implantação abaixo exige autorização própria.

## 1. Escopo do piloto

| Item | Valor |
|---|---|
| Unidade | **uma**: Açaí no Grau Saci (recomendada, ver §2) |
| Conversa | **uma** conversa privada, de uma pessoa autorizada; nenhum grupo |
| Operações | **só consultas** (leitura); nenhuma proposta, nenhuma movimentação |
| IA | `claude-haiku-5-5`, exclusivo, sem alternativa; só interpreta a pergunta e escolhe a consulta |
| Números | calculados pelo Financeiro v2; a IA nunca recebe nem redige valores (respostas naturais **desligadas**) |

## 2. Unidade piloto

**Recomendação: Açaí no Grau Saci.** A avaliação da qualidade dos dados reais foi feita fora do repositório (relatório privado da Execução 16A). Aqui ficam só os critérios e as fontes estruturais de cada unidade.

| Critério | Açaí no Grau Saci | Subway Saci |
|---|---|---|
| Presencial | SAIPOS **por pedido** (venda a venda) | SWF: total do período (relatório 76), sem valor por dia |
| iFood | relatório oficial do iFood | relatório oficial do iFood |
| 99Food | relatório oficial da 99Food | relatório oficial da 99Food |
| Anota AI | pela SAIPOS (regra da unidade) | — |
| Granularidade | por pedido, com recebíveis por venda | por período no presencial |

O critério decisivo é a granularidade: com vendas por pedido e recebíveis por venda, o MOVA consegue mostrar cobertura por dia e comprovação por canal.

**As limitações dos dados reais não são escondidas.** Faltando dias, canais ou conferências, a resposta diz "dados até", "sem dados registrados — não é zero confirmado" ou "aguardando conferência".

## 3. Consultas

O fluxo é o mesmo para todas:
1. a IA escolhe a consulta, de uma lista fechada;
2. o backend confere a conversa autorizada e a unidade;
3. o backend lê pelo núcleo do Financeiro, só com a ação `ver`;
4. o backend monta a resposta com a unidade, o período e a posição de leitura ("Posição do Financeiro em …").

| # | Pedido | Ferramenta / leitura | Situação para o piloto |
|---|---|---|---|
| 1 | Faturamento bruto | `FATURAMENTO` → `consultarVendas` | **pronta**; valor da DRE com a situação |
| 2 | Faturamento líquido | `DRE_RESUMO` → `apurarCompetencia` (receita líquida comercial) | **pronta com situação**; sem apuração = "sem dado confirmado" |
| 3 | Faturamento por canal | `FATURAMENTO`: composição `porCanal` da DRE + `consultarCalendarioDeFaturamento` | **nova (16A)**; fonte oficial, comprovado/sem comprovação, "dados até", dias sem registro ou com pendência; canal vazio ≠ zero |
| 4 | Despesas | `DRE_RESUMO` (despesas operacionais) e `DESPESAS_POR_CATEGORIA` (contas da competência) | **pronta**; competência ≠ pagamento |
| 5 | Custos | `DRE_RESUMO` (custos operacionais) | **pronta com situação** |
| 6 | Contas a pagar | `CONTAS_A_PAGAR_ABERTAS` → `consultarContasAPagar` | **pronta**; abertas e vencidas |
| 7 | Contas a receber | `CONTAS_A_RECEBER` → `consultarResumoFinanceiro` | **pronta** |
| 8 | Vencimentos | `CONTAS_VENCENDO` (período informado ou próximos 7 dias) | **pronta** |
| 9 | Fluxo de caixa | `FLUXO_DE_CAIXA` → `consultarFluxoDeCaixa` (realizado) | **pronta**; caixa ≠ resultado |
| 10 | Pendências de conciliação | `PENDENCIAS` → `consultarPendencias` | **pronta** (quantidade) |

**Fora do piloto, por desenho:**
- comparativo entre unidades: o piloto tem uma unidade só;
- saldo bancário, dados de pessoa e linha a linha de fornecedor: política de privacidade, bloqueio antes da IA;
- lançamentos, comprovantes e documentos: o piloto responde que só faz consultas, e documento nem vai à IA;
- resposta redigida pela IA: desligada, porque os valores iriam ao provedor.

**Faturamento por canal, regra de origem:** o MOVA **não soma fontes**. O valor de cada canal é o da composição da DRE, que já aplica a fonte oficial de cada canal:
- Açaí: SAIPOS no presencial, iFood e 99Food pelos relatórios oficiais;
- Subway: SWF no presencial.

O MOVA só mostra esses valores, com a cobertura de dias do calendário de cada canal. Período parcial, por exemplo "ontem", não ganha divisão por canal, porque a DRE é da competência.

## 4. Acesso somente leitura

```
WhatsApp ─ Gateway ─ relé (homologação) ─ backend local (MOVA, modo PILOTO)
                                                   │  estado do MOVA: banco de HOMOLOGAÇÃO (marcador conferido)
                                                   └─ Financeiro REAL: credencial fv2_mova_leitor_piloto
                                                        membro só de fv2_leitor_mova (migração 0028)
```

Barreiras, todas testadas em PostgreSQL real (`test/financeiro-v2/leitor-mova.test.js`):

1. **Papel `fv2_leitor_mova`:**
   - SELECT só nas tabelas que a aplicação já lê, e EXECUTE só em funções de leitura;
   - **nenhum** INSERT, UPDATE, DELETE ou TRUNCATE;
   - não emite sessão de outra pessoa (`fv2_abrir_sessao` negado) e não grava concessão.
2. **Sessão `fv2_abrir_sessao_mova`:**
   - só para a identidade técnica do MOVA (`IDENTIDADE_MOVA`);
   - só onde ela tem concessão ATIVA exatamente igual a `["financeiro_v2.ver"]`;
   - `pode_escrever = false`, validade de 5 minutos;
   - a RLS da sessão limita à organização e à unidade.
3. **Gatilho na concessão:** a identidade do MOVA nunca fica ATIVA com outra ação, nem por engano de administrador. Revogar continua sempre possível.
4. **Antes de montar, `verificarLeitorSomenteLeitura`** confere no banco que a credencial não escreve, não é administrativa e não é papel da aplicação ou da autoridade. Se for, o MOVA não sobe.
5. **Configuração (`MOVA_MODO=PILOTO`):** a credencial de leitura nunca pode ser a da aplicação, da autoridade, do MOVA ou do relé. A identidade tem de ser a do leitor. A montagem recusa:
   - mais de uma unidade;
   - grupo;
   - unidade diferente da declarada;
   - banco do MOVA sem o marcador de homologação.
6. **A IA não escreve SQL:** a porta financeira aceita só uma lista fechada de leituras do núcleo.

**Isolamento entre empresas:**
- o núcleo do MOVA só conhece o escopo do piloto;
- o banco recusa sessão em unidade sem concessão do MOVA;
- a RLS esconde as linhas de qualquer outra organização ou unidade.

Os testes 16A-05 (motor) e "lê as contas da SUA unidade" (banco) provam isso com uma segunda empresa com dados.

## 5. Integração e implantação (cada passo exige autorização própria)

### 5.1 Integração dos três PRs com um único deploy
- Pilha: **#154** (base `main`) ← **#156** (base `feat/mova-rele-homologacao`) ← **#158** (base `fix/mova-15h-saudacao-destino`).
- A simulação dos três merges em sequência sobre a `main` atual não tem conflito e **não altera nenhum arquivo do Gateway**.
- O backend de produção redeploya a cada merge que mude `backend/`. Para publicar **uma vez só**, mescla-se **de cima para baixo nas branches empilhadas**: #158 → #156 → #154. Só o último merge, o do #154 na `main`, publica. Os dois primeiros apenas atualizam branches de feature.
- Com o deploy, o MOVA continua **desligado em produção**: o boot registra `MOVA: DESABILITADO (DESLIGADO)` e nenhuma variável `MOVA_*` está ligada. O código do piloto só é executado com `MOVA_MODO=PILOTO`, no backend local.
- **Nenhum código publicado depende da migração 0028 em produção**. A ordem entre o merge e a 0028 é livre; recomenda-se o merge primeiro.
- O `frontend/` é servido pelo mesmo checkout: o deploy leva também os 2 arquivos da tela Centro Financeiro, que já tem estado "indisponível" sem o MOVA.
- Reversão do código: deploy do commit anterior no Render. O banco não é afetado.

### 5.2 Sequência até a primeira pergunta real
| Passo | O quê | Onde | Reversão |
|---|---|---|---|
| P1 | merges #158 → #156 → #154 (um deploy) | GitHub, Render | deploy anterior |
| P2 | backup do Financeiro e foto do inventário; `atualizar.sql` (só a 0028; aborta se produção não estiver exatamente na 0027); foto do inventário depois | Financeiro **produção** | a 0028 não altera dados; desligar pelo P3-reversão |
| P3 | login do leitor: `FV2_MOVA_LEITOR_SENHA=<senha> node scripts/fv2/pacoteProducao.mjs --mova-login fv2_mova_leitor_piloto`; a senha entra como verificador SCRAM e **nunca aparece em SQL ou log**; conferir com `--mova-verificar` | Financeiro **produção** | `--mova-desativar` (bloqueia o login e derruba as conexões; não apaga nada) |
| P4 | concessão "ver" da identidade do MOVA **só** na unidade piloto: `node scripts/fv2/pacoteProducao.mjs --mova-concessao <empresa> <unidade>`; recusa se já existir concessão ativa em outra unidade | Financeiro **produção** | revogar pelo Financeiro (a sessão já emitida é encerrada na hora) |
| P5 | no banco do MOVA (homologação): substituir as unidades fictícias da conversa privada pela unidade piloto, com as fontes de faturamento dela; backup das linhas antes | MOVA homologação | restaurar as linhas |
| P6 | orçamento novo e exclusivo do Haiku: poucas chamadas e teto de custo pequeno, somados ao consumo já registrado | MOVA homologação | voltar os limites anteriores |
| P7 | perfil local do piloto: `MOVA_MODO=PILOTO`, `MOVA_AMBIENTE=piloto`, `MOVA_FINANCEIRO_LEITURA_URL`, `MOVA_PILOTO_UNIDADE_ID`, `MOVA_SERVICO_USUARIO_ID` da identidade do MOVA, IA ligada, respostas naturais desligadas, teto de 1 resposta; ativação como na 15I e **uma** pergunta | máquina local, Render | desligar controle, relé e flag |
| P8 | primeiro grupo real: **etapa posterior**, ver 5.3 | — | — |

Os valores reais (IDs, SQL do P5 e do P6, números do orçamento) ficam no roteiro privado, fora do repositório.

### 5.3 Primeiro grupo real (não faz parte do piloto)
O modo PILOTO recusa grupos de propósito. Para um grupo é preciso, antes:
1. lista de participantes autorizados por grupo (hoje todo participante de um grupo autorizado é registrado automaticamente);
2. validar o envio a grupo pelo Gateway no ambiente real;
3. definir quais consultas valem em grupo;
4. um grupo real pequeno, com poucos participantes.

Isso é uma etapa de desenvolvimento própria e só começa depois da primeira pergunta privada validada.

## 6. Testes desta execução (sem rede, sem custo)

- **`test/financeiro-v2/leitor-mova.test.js` (PostgreSQL real, 11 testes):**
  - a verificação aprova o leitor e recusa a credencial da aplicação;
  - o MOVA lê só a sua unidade, e a outra empresa é recusada pelo núcleo e pelo banco;
  - sem concessão não há sessão, e sessão de outra identidade é negada;
  - nenhuma escrita passa, nem com sessão válida;
  - concessão com qualquer ação além de "ver" é recusada;
  - revogar desliga na hora, inclusive a sessão já emitida;
  - sessão expirada não vale; sem sessão a leitura direta não vê nada; com sessão de A só aparece A;
  - `SET ROLE` para os papéis do módulo é negado (sem elevação);
  - **as 11 leituras do MOVA funcionam só com SELECT**.
- **`test/mova-financeiro/execucao16a.test.js` (motor real, Financeiro em memória, IA simulada, 15 testes):**
  - consulta autorizada com divisão por canal;
  - conversa não autorizada;
  - dados ausentes;
  - valores não conciliados;
  - unidade e empresa erradas (toda leitura com a unidade do piloto, a identidade do MOVA e só `ver`);
  - rastreabilidade (todo R$ da resposta existe no retorno do Financeiro);
  - falha na conexão financeira;
  - orçamento de IA esgotado (não pede para reenviar);
  - suspensão;
  - deduplicação;
  - piloto só de consultas (sem proposta; documento não vai à IA);
  - saudação do piloto;
  - configuração;
  - escopo;
  - montagem recusada sem marcador ou com leitor que escreve.
- **`test/financeiro-v2/mova-implantacao-sql.test.js` (PostgreSQL real, 2 testes):** concessão só-ver idempotente com histórico; login com verificador SCRAM que conecta de verdade e passa na conferência do próprio MOVA; conferência pós-criação; desligamento de emergência; recusas (outra unidade, papel reservado ou inválido, senha curta).
- **Ensaio do pacote de produção (`atualizacao-producao.test.js`):**
  - de 0027 para 0028 sem mexer em dado;
  - repetir o pacote é recusado;
  - o papel nasce sem escrita.
