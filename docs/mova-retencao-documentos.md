# MOVA — armazenamento e retenção de documentos (proposta, NADA ativado)

Estado em 22/11/2026: `mova.evidencia` = 0 arquivos, `mova.documento` = 0, fila sem conteúdo de arquivo. A rotina de limpeza
`mova.expurgar_evidencias` existe mas **não está agendada** e continua assim até a aprovação desta política.

## Onde o arquivo fica (depois do PR de autorização antes da gravação)

| Lugar | O que guarda | Quando |
|---|---|---|
| `mova.fila.carga` | base64 só enquanto o item pode ser tentado de novo | apagado (`base64 = null`) ao concluir ou desistir |
| `mova.evidencia.conteudo` | o original (bytea), preso à organização/unidade | só depois de autorizar remetente, perfil na unidade, formato, tamanho e integridade |
| `mova.documento` | metadados (modo `SEM_LEITURA`, legenda, remetente) | após gravar a evidência |
| `mova.auditoria` | recebimento, conferências e cada abertura do original | sempre (só inclusão) |

Quem não pode enviar documento (CONSULTA, desconhecido, revogado no banco, grupo aberto) não gera nenhuma dessas linhas.

## Retenção proposta (a aprovar)

| Tipo informado na conferência | Guarda mínima | Motivo |
|---|---|---|
| Nota fiscal, boleto, comprovante de pagamento, recibo | 5 anos após o exercício | prazo fiscal/contábil (CTN art. 173-174); confirmar com a contabilidade |
| Documento de pessoal (folha, FGTS) | conforme a contabilidade (pode exigir prazos maiores) | obrigações trabalhistas/previdenciárias |
| "Outro" / não conferido | 400 dias (o `expira_em` atual) | só se NÃO estiver vinculado a pendência |

Regras antes de qualquer limpeza automática:
1. **Nunca** expurgar documento `AGUARDANDO_CONFERENCIA`, `REVISADO` ou `ENCAMINHADO` com conta vinculada — a função atual só
   protege documentos ligados a PROPOSTA; precisa de migração que também proteja documentos sem leitura e por tipo.
2. Prazo por tipo informado (coluna/registro de retenção), não um único `expira_em`.
3. Expurgo zera só o conteúdo (`conteudo = null`, `removida_em`) e mantém metadados + hash + trilha (já é assim).
4. Executar primeiro em modo "prévia" (contagem do que seria removido), com aprovação do proprietário, e só então agendar.

## Acesso aos originais
- Rota `/api/mova/arquivo`: permissão `financeiro_v2.documentos`, só da unidade da sessão, hash conferido (adulterado ⇒ 409).
- Cada abertura grava `DOCUMENTO_ORIGINAL_ABERTO` (usuário, organização, unidade). Sem trilha, o arquivo não sai.
- `anon`/`authenticated` não leem o schema `mova`; o MOVA usa `mova_app` sem DELETE/TRUNCATE.

## Limites e sustentabilidade no PostgreSQL
- Limite por arquivo: 15 MB (Gateway e backend). Banco atual: ~624 MB.
- Estimativa: 1 unidade, ~10 documentos/dia de ~300 KB ⇒ ~1 GB/ano. Aceitável no PostgreSQL por enquanto, mas cresce o backup
  e o tempo de restauração. Proposta: alerta quando `mova.evidencia` passar de 2 GB e, antes de ampliar para mais unidades,
  mover o conteúdo para um bucket PRIVADO (o padrão de `cofreNotasSupabase.js`), mantendo hash e trilha no banco.
- Backups: o backup gerenciado do Supabase inclui o conteúdo `bytea`. **A conferir pelo proprietário**: plano, frequência e
  retenção dos backups (e se há PITR) — não é visível pelas ferramentas usadas aqui.
- Limite de armazenamento por unidade (proposta): teto diário de 100 documentos por grupo; acima, o MOVA responde que recebeu o
  limite do dia e nada é gravado (a implementar só se aprovado).
