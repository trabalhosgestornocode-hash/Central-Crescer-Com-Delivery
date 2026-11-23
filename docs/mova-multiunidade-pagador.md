# MOVA multiunidade — unidade pelo pagador, Açaí + Subway, boletos e notas no Contas a Pagar

Estado: **código pronto; nada ativado em produção.** Este PR não aplica migração, não grava cadastro, não concede permissão
e não liga chave. Cada passo de ativação abaixo exige aprovação específica.

## O que muda

1. **Unidade pelo titular da conta pagadora.** O comprovante traz o pagador (titular da conta de origem) e, quando impresso,
   o CPF/CNPJ dele. O cadastro da unidade no MOVA ganha `pagadores` (migração MOVA 0015):
   - Açaí no Grau Saci: `[{"nome": "<titular da conta pagadora do Açaí>"}]`;
   - Subway Saci: `[{"nome": "<titular da conta pagadora da Subway>"}]` (e, se houver, `{"documento": "<CNPJ da conta>"}`).
   Os titulares reais são informados pelo proprietário no cadastro (kit abaixo), nunca no repositório.
   Regras (em `dominio/pagador.js`, um único lugar):
   - só os campos **pagador** e **documento do pagador** contam. Favorecido, descrição e legenda nunca identificam a unidade;
   - o nome é comparado depois de normalizado (sem acento, pontuação ou caixa). Para nomes de 4+ letras, aceita sufixo
     societário (LTDA, ME, EPP…). **Nome curto ("MP") só por igualdade exata**: "MP LTDA", "MERCADO PAGO" e "AMP" não casam;
   - documento mascarado nunca identifica; nome de uma unidade + documento de outra = conflito;
   - o mesmo pagador em duas unidades é recusado na montagem.
   O pagador **não dá acesso**. Se a conversa não atende a unidade do pagador, o MOVA orienta o canal autorizado e não registra
   nada. Se a legenda ou o documento apontarem outra unidade, ele pergunta, e insistir não força o registro.
2. **Açaí e Subway na mesma conversa.** Os dois estão em **empresas diferentes** no Financeiro, e até aqui a conversa privada
   nunca juntava empresas. A Subway (unidade sem grupo, #187) ganha no cadastro:
   - `participantes`: quem pode enviar documentos dela no privado;
   - `acesso_multiempresa`: autoriza juntar a Subway às unidades que a pessoa já tem pelo grupo do Açaí.
   Sem essa marca, a conversa com duas empresas é descartada, como antes. Faturamento de empresas diferentes nunca é somado.
3. **Boleto/nota → Contas a Pagar e calendário oficiais.**
   - **Boleto** (ou nota a pagar) com fornecedor, vencimento, competência e categoria definidos vira conta a pagar EM ABERTO,
     com o documento anexado. Usa o serviço oficial `registrarObrigacaoDocumental` (ação estreita `registrar_obrigacao`) e
     aparece no Contas a Pagar e no calendário oficial. Nenhuma baixa sem comprovante.
   - **Nota fiscal** de conta já registrada (mesmo fornecedor e valor) é **anexada** à conta, sem conta ou despesa nova (proposta
     `VINCULO_DE_DOCUMENTO`). Mais de uma conta compatível vai para conferência.
   - Chave própria `MOVA_OPERACAO_CRIAR_CONTAS` (desligada; exige a autonomia) e políticas `CONTA_A_PAGAR` e `ANEXAR_DOCUMENTO`.
4. **Políticas por operação, sem teto universal.** Não existe teto de R$ 500 no código: cada operação tem a própria política por
   unidade. As operações são compra nova já paga (`DESPESA_DOCUMENTAL`), baixa de conta existente (`BAIXA_DOCUMENTAL`), conta a
   pagar nova (`CONTA_A_PAGAR`), anexo de nota (`ANEXAR_DOCUMENTO`) e juros (`JUROS_DOCUMENTAL`, inalterada). Acima do limite, a
   operação vira confirmação de uma pessoa: o valor sozinho nunca impede o cadastro. A conta a pagar nova automática deixou de
   ser proibida no banco (0015) e depende de política explícita. Duplicidade, idempotência, auditoria e permissões estão mantidas.
5. **Correção:** a escolha da categoria nunca funcionava. O plano de contas vem em árvore e era lido como lista plana, então
   tudo ia para "a classificar". Agora a árvore é percorrida, e a sugestão que é exatamente o código de uma categoria do plano
   vale. Fora isso, continua valendo só uma categoria casando.

## Ativação (nesta ordem; cada passo com aprovação específica)

0. Merge deste PR (deploy automático; nada muda sem os passos abaixo).
1. Backup dos schemas `mova` e `financeiro_v2`. Aplicar `database/mova-financeiro/producao/atualizar.sql`, que traz só a 0015.
   Recuperação: `database/mova-financeiro/recuperacao/reverter-0015.sql` (ensaiada: volta byte a byte ao retrato da 0014).
2. Cadastro pelos kits (geram SQL para revisar; não executam):
   - Açaí: `node scripts/mova/acessoDaUnidade.mjs --unidade <id Açaí> --pagador "<titular>" --motivo "…"`;
   - Subway: cadastro da unidade sem grupo (`scripts/mova/unidadeSemGrupo.mjs`, fontes SWF + iFood + 99Food), depois
     `node scripts/mova/acessoDaUnidade.mjs --unidade <id Subway> --sem-grupo --pagador "<titular>" --participante '<json>' --multiempresa --motivo "…"`.
   - **Conferir também as fontes do Açaí** no MOVA: hoje estão `A_CONFIRMAR`, e isso bloqueia a aplicação de propostas na Central
     (`REQUISITOS_FINANCEIROS_INCOMPLETOS`).
3. Concessão "ver" da identidade de leitura do MOVA na Subway (`pacoteProducao.mjs --mova-concessao … --alem-de …`) e
   `MOVA_OPERACAO_UNIDADES` com as duas unidades. Reiniciar o MOVA.
4. **Caminho oficial (24/11):**
   - a concessão da identidade operacional é feita pelo **administrador financeiro corporativo, logado**, no painel de ativação
     ("4. MOVA — lançamentos automáticos"), rota `POST /corporativo/mova-operacional`. O beneficiário é fixo
     (`MOVA_IDENTIDADE_OPERACIONAL` do servidor), as ações são só as estreitas e a auditoria fica em nome do administrador,
     pela mesma função do banco das concessões às pessoas;
   - as políticas são criadas na Central do MOVA (Segurança), que agora oferece as cinco operações, com o usuário logado como autor.
   Os geradores SQL abaixo ficam para ensaio, teste e emergência de infraestrutura (assinam como autoridade técnica), nunca em
   nome de outra pessoa.
   Escrita (só quando aprovada): identidade operacional PRÓPRIA (`MOVA_IDENTIDADE_OPERACIONAL`, `MOVA_OPERACAO_ESCRITA=1`) com concessão
   **por unidade** pelo gerador revisado:
   - conceder ou alterar: `node scripts/fv2/pacoteProducao.mjs --mova-operacional <empresa> <unidade> --identidade <uuid> --acoes financeiro_v2.ver,financeiro_v2.enviar_documento,financeiro_v2.baixar_por_comprovante,financeiro_v2.registrar_obrigacao[,financeiro_v2.registrar_juros] --concedido-por <uuid> --justificativa "…"`;
   - revogar: `--mova-operacional-revogar`.
   O gerador recusa:
   - ação ampla (registrar, corrigir, cancelar, aplicar, conceder…) e lista sem `ver`;
   - a identidade de leitura, a de entregadores e o executor técnico;
   - identidade que já tenha ação ampla em qualquer unidade.
   Ele confere também as migrações 0030/0031, grava histórico e revoga cada unidade de forma independente (testado no
   PostgreSQL real: `test/financeiro-v2/mova-identidade-operacional-sql.test.js`).
   Políticas pelo kit `scripts/mova/politicasDaUnidade.mjs`:
   - nível e limite **explícitos** por operação e por unidade; não há padrão nem "ilimitado";
   - reaplicar troca a política vigente; `--revogar-todas` desliga a autonomia da unidade.
5. `MOVA_OPERACAO_CRIAR_CONTAS=1` para boletos e notas.
6. Homologação real nas duas unidades: um comprovante pago pela conta de cada empresa, um boleto e uma nota, com acompanhamento.

Desligar: revogar a política (vale na hora) ou a concessão; desligar a chave; `acesso_multiempresa = false` e reiniciar.

## Testes (`test/mova-financeiro/mova-multiunidade-pagador.test.js`)

25 testes cobrem:
- os casos 1–20 pedidos (titulares sintéticos): titular A→unidade A; titular "MP"→unidade B; MP na descrição, "Mercado Pago" e MP no favorecido não identificam; documento
  sem identificação pergunta; conflito não grava; identidade só de uma empresa não escreve na outra; a conversa que só atende uma
  unidade, ao receber comprovante da outra, orienta o canal certo; isolamento com as duas;
- compra nova, conta existente, parcial, juros, duplicado e reenvio;
- boleto no Contas a Pagar e no calendário;
- nota vinculada a conta existente;
- falha intermediária sem duplicar;
- nenhuma transferência ou saída bancária.
Os mesmos testes passam com o Financeiro v2 no PostgreSQL real (RLS e gatilhos da 0030).
Simulação não substitui a homologação operacional.
