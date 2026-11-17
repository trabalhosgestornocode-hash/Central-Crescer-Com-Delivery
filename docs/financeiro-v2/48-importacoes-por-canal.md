# 48 — Fase 11: importações dentro da página de cada canal

> Documento público: **nenhum valor, nome ou pedido real**. Tudo foi conferido com dados sintéticos. Nada foi publicado, migrado, gravado em
> dados reais, nem teve permissão alterada. A importação de 16/11 em produção **não** foi corrigida.

## 1. O que mudou
Cada área de faturamento tem agora a sua aba ou seção **Importações**, no mesmo padrão visual: SAIPOS (aba Importações), iFood e 99Food
(abas **Resumo | Importações**). A rotina diária cabe na página do canal:
**SAIPOS → Importações → escolher o arquivo → conferir a prévia → confirmar → gerar e aplicar as propostas → fechar o painel → o calendário e os cards já mostram o dia.**
A Central de Importações e Conferências continua igual e vira só um atalho (histórico geral, auditoria, outros tipos de documento).

## 2. Quais botões funcionam hoje e quais dependem de relatório oficial
| Botão | Situação | Como foi comprovado |
|---|---|---|
| **SAIPOS › Enviar e gerar a prévia** (Vendas por período XLSX, Formas de pagamento, Canais de venda, Faturamento por dia PDF) | **Funciona** | Envio de arquivo pelo mesmo caminho da plataforma (backend, memória e PostgreSQL) e pelo navegador com arquivo sintético escolhido no computador |
| SAIPOS › Confirmar importação · Gerar propostas · Aprovar e aplicar · Rejeitar arquivo | **Funciona** (é o detalhe da Central, aberto no painel) | Testes de backend e fluxo completo no navegador |
| iFood › **Conferir prévia** e **Confirmar e registrar demonstrativo** | **Funciona** (digitação conferida do demonstrativo oficial; não é leitura de arquivo) | Testes de backend e fluxo no navegador |
| iFood › Apuração financeira em **arquivo** | **Indisponível**: o leitor é só um contrato sintético, nunca validado com arquivo oficial real. O envio é recusado pelo servidor | Teste: o servidor recusa o tipo; a tela mostra o motivo e não tem botão |
| iFood › **Relatório oficial de pedidos** | **Indisponível**: não existe leitor | Idem |
| 99Food › qualquer envio | **Indisponível**: campos e botão desabilitados, mensagem "precisamos validar o primeiro relatório oficial". Nada pode ser enviado nem confirmado | Teste: o servidor recusa qualquer tipo 99Food; no navegador o botão está desabilitado |

**O que não foi coberto (para não superestimar):** o login real da plataforma e o envio multipart pelo navegador contra o servidor de produção.
O navegador usa a demonstração local, que chama exatamente a mesma ação de envio da plataforma. A leitura do arquivo **real** `Vendas por período.xlsx`
foi conferida só no motor, em memória (Fase 09), não pelo navegador.

## 3. SAIPOS
- Seção com os formatos (selo "Disponível", "Principal" e "Leitor homologado" vindos do servidor), unidade, período, arquivo, confirmação, histórico e atalho para a Central.
- **Prévia por canal** (no detalhe do documento): Presencial e Anota Aí com pedidos e valor; iFood e 99Food como **"só conferência: NÃO vira receita"**; canal não
  identificado como pendência; cancelados à parte. A contagem por canal é nova na prévia do leitor existente (acréscimo, sem leitor novo).
- **Duplicidades:** o mesmo arquivo é a mesma importação; período sobreposto reconhece o que já entrou. Já existia no motor; agora aparece na tela.
- **Conflito entre importações:** se outra importação de **outra granularidade** (por forma, por dia, total do período) já foi aplicada nos mesmos dias, a prévia
  **avisa antes de confirmar** e a aplicação continua sendo recusada (sem faturamento em dobro).
- **Calendário:** ao aplicar as propostas e fechar o painel, os calendários do Presencial e do Anota Aí e os cards já estão atualizados.

## 4. iFood
- Aba Importações com o demonstrativo oficial e o status dos outros formatos.
- **Prévia do demonstrativo (sem gravar):** período, faturamento, comissões, taxas, mensalidade, serviços e promoções, ajustes, líquido, **repasse previsto**,
  se a conta fecha (ou a diferença), o que bloqueia e as pendências. Só quando **fecha** e não há bloqueio aparece "Confirmar e registrar".
- Bloqueios: conta que não fecha, período sobreposto a outro demonstrativo, vendas iFood da SAIPOS já aplicadas no período, competência que não aceita lançamentos.
- **Defeito encontrado e corrigido:** o registro só impedia o **mesmo** período em duplicidade. Dois períodos **diferentes que se sobrepõem** somariam o
  faturamento duas vezes. Agora são recusados na prévia e no registro.
- A SAIPOS nunca é fonte do faturamento iFood (já era regra; agora a prévia também avisa).

## 5. 99Food
Seção preparada (formato, período, arquivo, histórico, estados), **toda bloqueada** até existir o primeiro relatório oficial validado. Nenhum formato é presumido.

## 6. Arquitetura (sem duplicar processo)
- Envio, prévia, confirmação, propostas e aplicação: **os mesmos** serviços da Central. Nenhum importador novo.
- Novas consultas só de leitura: `/importacoes-canal` (formatos, estado, histórico) e `/previa-demonstrativo-ifood`. Nenhuma tabela nova, **nenhuma migração**.
- As importações do canal só são consultadas quando a aba Importações está aberta; nenhuma conta com dinheiro no frontend.
- O catálogo de formatos por canal fica no servidor; um teste confere que o que está "liberado para arquivo" coincide com a lista de tipos aceitos pela camada HTTP.

## 7. Arquivos
**Novos:** `aplicacao/importacoesPorCanal.js`, `test/financeiro-v2/importacoes-por-canal.test.js`, `frontend/financeiro-v2/telasImportacoesCanais.js`,
`frontend/test/financeiroV2ImportacoesCanais.test.js`, este documento.
**Alterados:** `fontes/saipos.js` (contagem por canal na prévia), `aplicacao/demonstrativoIfood.js` (prévia e recusa de sobreposição), `aplicacao/conferencias.js`
(aviso de conflito), `aplicacao/nucleo.js`, `fv2-integracao/consultas.js`, `scripts/fv2/demoInterface.mjs` (rotas novas e envio real de arquivo sintético),
`scripts/fv2/navegadorCanais.mjs` (13 verificações novas; 2 obsoletas removidas), `app.js`, `telasCanais.js`, `telasConferencias.js`, `fv2.css`.

## 8. Resultados (17/11/2026, todos terminaram)
| Suíte | Total | Aprovados | Falhas | Ignorados |
|---|---|---|---|---|
| Backend em memória | 513 | 513 | 0 | 0 |
| Backend no PostgreSQL local (banco exigido) | 513 | 513 | 0 | 0 |
| Frontend | 2018 | 1992 | 0 | 26 (navegador de outros módulos) |
| Navegador (Chrome real, demonstração limpa) | 76 | 76 | 0 | 0 |

Cobertura pedida: upload SAIPOS · prévia · cancelamento · separação de canais · deduplicação · bloqueio de importações conflitantes · importação iFood ·
recusa de formato desconhecido na 99Food · permissões por unidade · atualização do calendário após confirmar · responsividade · navegador.

Ajustes no caminho: duas verificações antigas de navegador (do botão que abria o painel) foram **removidas** porque o botão foi substituído pela seção; uma
verificação de "drill-down" passou a olhar só o conteúdo da tela (o painel fechado guardava botões do último detalhe).

## 9. Pendências e riscos
- **D4:** o iFood por arquivo e por pedidos e a 99Food dependem de relatório oficial real. Sem ele, o detalhe diário não existe (por regra).
- O roteiro de navegador altera a demonstração (importa arquivos, registra um demonstrativo): reiniciar a demonstração antes de rodá-lo.
- A confirmação do arquivo continua no detalhe aberto em painel (o mesmo da Central), não numa tela própria do canal: um só lugar para a regra.
- Login real da plataforma não coberto pelo navegador.

## 10. Impacto no plano de publicação
Nenhuma migração nova. Código: duas rotas de consulta novas e a recusa de demonstrativo sobreposto no registro do iFood (comportamento mais restritivo).
Acrescentar ao checklist de leitura (doc 46 §4.5): abrir as abas Importações dos três canais (só leitura) e conferir os formatos e os estados.

## 11. Classificação
**GO CONDICIONAL**, nas mesmas condições da publicação (D1, D3, D4, autorização) mais a conferência em leitura com o login real.
