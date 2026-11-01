# 41 — Termo v2 (rascunho) e piloto do primeiro destinatário dos relatórios

Sem telefones, nomes de pessoas ou ids de pessoas (repositório público). Os valores ficam no chat e no painel do Render.

## Termo v2 (migration 143 — preparada; aplicada só no projeto de teste)
- Texto curto escolhido, em `comunicacao_termos` como **versão 2, `rascunho = true`**, hash = sha256 do texto (CHECK do banco). A v1 e todo o histórico de consentimentos permanecem intactos (termos são imutáveis).
- **Não está aprovado**: enquanto a versão vigente (maior versão) for rascunho, o consentimento real segue recusado (409 `TERMO_NAO_APROVADO`). A migration aborta se a v2 nascer aprovada.
- Identificação da empresa responsável e contato de privacidade: **marcador visível `[PENDENTE DE VERIFICAÇÃO JURÍDICA …]`** no texto — nada foi inventado. Para aprovar: o jurídico informa os dados verificados → insere-se a **v3** (rascunho = false) com o marcador substituído (a v2 nunca é editada).
- Categorias `fechamento_operacional_diario` e `resumo_semanal`: rótulos "Relatório Operacional Diário" e "Resumo Operacional Semanal", `estado = ATIVA`, `transporte = baileys`, `ativo = false` (continuam invisíveis ao resolvedor do D-1 — a migration compara a linha da categoria do D-1 antes/depois e aborta se mudar).

## Tela do titular
Nenhuma categoria vem marcada; "Li e concordo com o termo." também começa desmarcado e o servidor exige `concordo === true` para registrar (recusar não exige); link da Política de Privacidade só com `NOTIFICACOES_POLITICA_PRIVACIDADE_URL` https (senão aviso de que o link ainda não foi publicado — bloqueia a aprovação do termo). O registro grava data, versão e hash do termo e a categoria/unidade.

## Primeiro destinatário (leitura de produção, sem alterações)
- Já é destinatário **legado operacional ativo** (WhatsApp validado, sem opt-out) da empresa dona das duas unidades-piloto; categorias legadas: só `pendencia_d1`; **0 escopos** nas categorias de relatório.
- As duas unidades (Subway Saci — Matriz e Subway North Shopping) pertencem à **mesma empresa**: **um único convite** cobre as duas unidades e as duas categorias.
- Como é legado, o convite é de **adesão voluntária** (`destinatarioId`): o cadastro legado e o `pendencia_d1` não são alterados; só entram consentimentos e escopos novos.

## Fluxo (cada passo com autorização do titular e do jurídico)
1. Gestor autorizado cria o convite (unidades: as duas; categorias: as duas; destinatário: o cadastro existente).
2. O titular abre o link → recebe **um** OTP pelo Baileys → confirma o número.
3. Lê o Termo v2 → marca as categorias (nenhuma pré-marcada) → marca "Li e concordo" → autoriza.
4. O sistema grava o consentimento (versão, hash, evidência do OTP) e os escopos (unidade × categoria, origem convite+OTP).
5. A partir daí o destinatário é elegível aos relatórios das duas unidades, conforme a integração iFood e o fechamento válido de cada dia.

## Bloqueios reais para o 1º envio
Termo v3 aprovado (dados legais verificados + link da Política) · autorização do titular para o OTP real · aplicar a 143 e a chave `convites_unidades_piloto` em produção · variáveis do Render (docs 40) · merge deste PR.
