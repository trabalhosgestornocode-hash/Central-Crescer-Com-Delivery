-- MOVA (25/11/2026): GRUPO COMPARTILHADO por duas empresas (caso real: "Contas à Pagar Subway / Açaí").
-- Marca EXPLÍCITA e auditável no grupo: sem ela, um grupo com unidades de duas organizações é recusado na montagem
-- (dominio/configuracao.js). Com ela, cada mensagem continua resolvendo UMA unidade (titular/CNPJ do comprovante, apelido ou
-- pergunta) e o escopo nunca junta organizações; a conversa privada derivada dos participantes passa a poder ter as duas.
-- Só acrescenta a coluna (padrão false): nenhum grupo muda de comportamento até ser marcado.
alter table mova.grupo_autorizado add column if not exists multiempresa boolean not null default false;
comment on column mova.grupo_autorizado.multiempresa is 'Grupo compartilhado por unidades de organizações diferentes (autorização explícita do proprietário). Cada mensagem resolve uma única unidade.';
