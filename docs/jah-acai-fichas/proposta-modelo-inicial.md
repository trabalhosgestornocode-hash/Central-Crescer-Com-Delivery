# Empresas independentes recebendo o catálogo Subway — causa e proposta de correção

Investigação **somente leitura** (13/11/2026). Nada foi alterado nas empresas afetadas. Nenhuma correção desta proposta
está implementada; os scripts de limpeza deste PR são a única peça pronta, e cada uso depende de autorização.

## O que acontece
O assistente de criação de empresa (Painel Administrativo → nova empresa → passo **"Modelo inicial"**) envia
`modeloOrigemId` para `POST /plataforma/empresas`. Se vier preenchido, `plataforma.empresas.service.js#criarEmpresa`
chama `shared/clonarCatalogo.js`, que copia categorias, insumos, produtos, ficha técnica e **todas as tabelas de preço**
do modelo para a empresa nova, e grava `organizacoes.modelo_origem_id`.

## Causa
Não é automático: o seletor começa em **"Nenhum"** e o backend só clona com um id explícito. A cópia indevida vem de
uma combinação de desenho:
1. **Existe um único modelo cadastrado** ("Subway Padrão"). O seletor mostra só o nome, sem segmento, sem dizer o que
   será copiado (61 produtos, 106 insumos, 20 tabelas de preço) e sem confirmação.
2. **Nada relaciona o segmento da empresa ao do modelo**: `validarModeloOrigem` só confere que o id é de uma empresa
   marcada como modelo (`eh_modelo`). Qualquer empresa pode receber qualquer modelo.
3. **Criação em série**: as empresas afetadas foram criadas no meio de dezenas de cadastros de lojas Subway feitos em
   poucos dias (o registro de auditoria `empresa.criada` mostra o mesmo modelo em todas). A escolha repetida do único
   modelo existente passa despercebida.
4. **Reclonagem silenciosa**: a aba "Modelo Inicial" (`POST /plataforma/empresas/:id/clonar-modelo`) clona de novo
   sempre que a empresa tem `modelo_origem_id` e zero produtos/insumos — exatamente o estado de uma empresa logo depois
   de uma limpeza. Por isso o script de limpeza deste PR **também zera `modelo_origem_id`** (com backup e reversão).

Situação medida em produção (só leitura): além do Jah, outras 3 empresas que não são Subway receberam a mesma cópia;
em todas, 100% dos produtos e insumos são o clone, sem uso (vendas, PDV, estoque, compras, histórico) e sem tabela
comercial oficial. A lista nominal fica no relatório privado.

## Proposta de correção reutilizável (a implementar em PR próprio, com aprovação)
1. **Segmento explícito** (migration aditiva): `organizacoes.segmento` (ex.: `subway`, `acai`, `cafeteria`,
   `pizzaria`, `pastelaria`, `outro`), obrigatório para modelos e preenchido no passo "Empresa" do assistente.
2. **Regra no backend** (`validarModeloOrigem`): recusar modelo de segmento diferente do da empresa, salvo
   `confirmarSegmentoDiferente: true`, registrado na auditoria `empresa.criada`. Testes de rota.
3. **Assistente**: o seletor lista só modelos do mesmo segmento, mostra o que será copiado (contagens e tabelas de
   preço) e a Revisão destaca "vai copiar N produtos do modelo X". O padrão continua "Nenhum".
4. **Reclonagem**: exigir confirmação e motivo; recusar quando houver registro de limpeza da empresa
   (`backup_ops.modelo_indevido_empresa`) ou quando `modelo_origem_id` estiver nulo (efeito da limpeza).
5. **Limpeza reutilizável** (pronta neste PR): `database/ops/remover_catalogo_modelo_indevido_{PREVIEW,APLICAR,
   REVERTER,RESTAURAR_ARQUIVO}.sql`, por empresa, sempre: backup somente-leitura com MD5 → PREVIEW → APLICAR com
   identidade (id + nome + modelo), contagens e impressão digital dos ids → conferência. Uma autorização por empresa.
6. **Detecção** (somente leitura, enquanto o segmento não existir): listar empresas cujo `modelo_origem_id` aponta
   para um modelo de outro segmento (hoje, por nome) e cujo catálogo continua 100% clonado e sem uso.

Ordem sugerida: 2+3 (impedem novos casos) → 4 → limpeza das empresas afetadas, uma a uma, com autorização.
