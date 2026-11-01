# 42 — Pacote de implantação do piloto, retenção real e termo v3 para aprovação

Sem telefones, nomes de pessoas ou ids: os valores exatos ficam no chat e vão direto ao painel do Render. A identificação da empresa e o contato de privacidade aparecem **só** na Política de Privacidade (variáveis `NOTIFICACOES_POLITICA_*`), nunca no termo.

## 1. Identificação empresarial (conferida em fonte pública)
Consulta pública do CNPJ informado: razão social idêntica à informada, nome fantasia "Crescer com Delivery", situação cadastral **ATIVA**, Sociedade Empresária Limitada, Teresina/PI. (O cadastro `organizacoes.cnpj` do sistema é o dos clientes, não o do controlador — não foi usado.)

## 2. Retenção e descarte REAIS (código e banco, em 01/11/2026)
| Dado | O que existe de fato |
|---|---|
| Texto de mensagens recebidas pelo WhatsApp (`comunicacao_inbox_mensagens`) | **Descarte automático em 30 dias** (padrão; `COMUNICACAO_INBOX_RETENCAO_DIAS` 1–365), purga a cada 6 h no processo web e na gravação; função `comunicacao_inbox_purgar` presente em produção |
| Código de segurança (OTP) | vale **5 minutos**; guardado só como HMAC, nunca em texto |
| Convite | expira em **72 horas** |
| Registro de consentimento (`comunicacao_consentimentos`) | **somente inclusão** (trigger recusa update/delete); **sem descarte automático** |
| Termos, fechamentos operacionais, resumos e fila de relatórios | somente inclusão / sem rotina de descarte |
| Dados de pedidos do iFood | proposta de anonimização escrita (doc `dashboard-operacional-2/03`), **não executada** |
Não há prazo de guarda pós-revogação nem rotina de expurgo do telefone cifrado: é a decisão **JUR-4**. O texto sugerido para `NOTIFICACOES_POLITICA_RETENCAO` descreve apenas o que existe; criar um prazo exigiria definição jurídica **e** uma rotina nova.

## 3. Termo v3 para aprovação jurídica e publicação imutável
- Texto: exatamente o aprovado para apresentação (arquivo `termo-v3-APROVAR-ANTES-DE-APLICAR.sql`), 633 caracteres, **sem** razão social, CNPJ ou contato.
- **sha256 do texto: `7441750a9ef52ce6a7093dd70ad82db0eed41e2e6eb8d914018279efce6e470d`** (o mesmo que o banco calcula e confere por CHECK).
- Validado em banco descartável sobre a cadeia com a 143: grava v3 `rascunho = false`, vigente, hash conferido; segunda aplicação é recusada ("já existe uma versão >= 3"); v1 e v2 intactas.
- Ao aprovar: mover o arquivo para uma migration numerada e aplicar com autorização específica. A partir daí o consentimento real deixa de responder 409.

## 4. Ordem de ativação do piloto (nada disso está ligado)
1. Variáveis da Política (4) → página `/notificacoes/privacidade.html` passa a "publicada" e o termo ganha o link.
2. Aprovação jurídica → aplicar a v3.
3. Variáveis do convite/OTP (`NOTIFICACOES_CONVITES_HABILITADOS`, `NOTIFICACOES_OTP_TRANSPORTE=baileys`, `NOTIFICACOES_OTP_BAILEYS_AUTORIZADO=true`, `NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164`).
4. Gestor autorizado cria **um** convite (adesão voluntária do cadastro legado existente; as duas unidades; as duas categorias) → o titular recebe **um** OTP, confirma, lê o termo, marca categorias e "Li e concordo".
5. Variáveis dos relatórios (`UNIDADES_PILOTO`, `ALLOWLIST_E164`, `MAX_DIA`, `SEMANAL_HABILITADO` conforme decisão) → `AGENDADOR_HABILITADO` → `ENVIO_HABILITADO`.

## 5. Prazo de retenção de 2 anos — o que exige (validado em 01/11/2026)
- **Hoje não existe exclusão automática** do registro de consentimento, dos convites/desafios, da fila e dos resumos de relatórios, nem do cadastro de destinatário: tudo é somente inclusão ou sem rotina de descarte (o consentimento é protegido por trigger contra update/delete). O único descarte automático comprovado é o do texto de mensagens recebidas (30 dias).
- **Nada vence antes de 2028:** o sistema não tem nenhum consentimento (0), convite (0) ou escopo (0), e os dados mais antigos de comunicação são de set–out/2026. Para o piloto **não há adequação técnica bloqueante**.
- **Adequação necessária antes do primeiro vencimento (≈ out/2028):** rotina de expurgo (função `security definer`, executável só pelo `service_role`, que remove em lote o que passou de 2 anos **contados do cancelamento ou do encerramento do serviço**, com exceção controlada às travas de imutabilidade e auditoria da própria exclusão). O marco inicial do prazo (cancelamento/encerramento) é uma definição **jurídica**: o texto da Política usa essa leitura e precisa ser confirmado.
- **Texto da Política**: afirma o prazo e a eliminação, **sem** dizer que é automática; o compromisso técnico acima fica registrado com data.

## 6. Pendências jurídicas restantes (status)
| Item | Status |
|---|---|
| JUR-1 controlador × operador | identidade do responsável informada; falta confirmar o **papel** (controlador/operador) de cada parte |
| JUR-2 base legal por categoria | Política declara consentimento (art. 7º, I); falta o jurídico ratificar |
| JUR-4 retenção | prazo informado (2 anos); falta confirmar o **marco inicial** |
| JUR-5 compartilhamento / transferência internacional | Política declara só os fatos (nuvem parcialmente fora do Brasil; WhatsApp); falta a hipótese do art. 33 |
| JUR-7 encarregado | contato informado (WhatsApp); falta confirmar se é o encarregado e o nome |
| JUR-6 SAIR | não se aplica ao piloto (SAIR desligado) |
**A v3 só é publicada após a aprovação.**
