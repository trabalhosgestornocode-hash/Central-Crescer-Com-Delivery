# Agenda de Demandas — proposta de campos estruturados (NÃO implementada)

## Situação atual
`desenvolvimento_demandas` não tem colunas para projeto, área de atuação, empresas beneficiadas nem responsável utilizável na prática. A interface lê projeto, área e empresas do cabeçalho padronizado do texto da descrição (`lerDescricao` em `frontend/src/desenvolvimentoDados.js`). O que não segue o padrão aparece como "Não informado" e fica fora dos recortes por projeto. Não há inferência por palavra-chave.

## Proposta
Migration aditiva, em etapa própria, com aprovação, teste em banco isolado e backup prévio:

| Campo | Tipo | Observação |
|---|---|---|
| `area` | `text` nulo, com `check` na lista oficial de áreas | substitui o mapeamento por categoria |
| `projeto` | `text` nulo (ou tabela `desenvolvimento_projetos` com nome único) | evita variações de grafia |
| `empresas_beneficiadas` | `text[]` nulo | "Todas as empresas e unidades" como valor próprio |
| `responsavel_usuario_id` | já existe | passar a ser preenchido e exibido por nome |

Passos: (1) criar colunas nulas; (2) preencher a partir do cabeçalho com relatório de divergências e sem sobrescrever o que já foi editado; (3) formulário com seletores; (4) a interface passa a preferir a coluna e usa o cabeçalho só como reserva; (5) após validação, aposentar o cabeçalho. Reversão: remover as colunas; o texto da descrição continua intacto.

Fora de escopo: nenhuma alteração de registros reais nesta etapa.
