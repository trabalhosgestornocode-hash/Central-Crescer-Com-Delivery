# 03 — Proposta visual: Configurações 2.0

> Preserva a identidade da Crescer com Delivery (tokens de cor, tipografia, `btn`, `pill`, `cfg-panel`, `icon()` de `icons.js`). Reaproveita os padrões do Dashboard Operacional 2.0: abas e listas com teclado, `aria-*`, estados de carga/erro/vazio, diálogos acessíveis e nenhuma rolagem horizontal da página.

## 1. Estrutura de informação

Sete categorias, com conteúdo derivado da auditoria (doc 01). Nada é duplicado de outros módulos: o que pertence a um módulo aparece como **atalho com estado**, não como cópia da tela.

| Categoria | Seções | Origem |
|---|---|---|
| **Unidade e empresa** | Identificação da unidade · **Fuso e horário de funcionamento** (novo) · Empresa (só leitura: nome, módulos contratados, unidades) | itens 1 e 3 do doc 01 |
| **Metas e operação** | Metas e limites de CMV · Tabelas comerciais · Atalhos com estado: Metas do Checklist, Modelo logístico iFood, Metas de Bonificação | itens 2, 3 + §3 |
| **Notificações** | Destinatários · Categorias e preferências · Horários · Histórico · Consentimentos (resumo) | doc 04 (novo) |
| **Usuários e acesso** | Equipe e cargos · Convites pendentes · (leitura) Perfis operacionais | item 4 |
| **Integrações** | Estado das conexões (iFood por loja, Martin Brower, demais do catálogo) com link para a página de cada integração | `views.js#renderIntegracoes`, `ifood.js` |
| **Segurança e privacidade** | Minha conta (nome, troca de senha) · 2FA · Sessões ativas · Privacidade (consentimentos dos destinatários, retenção — **leitura** até decisão) | item 5 + ausências |
| **Preferências** ("Outras configurações") | Aparência (tema) · Preferências deste dispositivo (exportar/limpar local) | itens 7 e 8 |

## 2. Layout

### Desktop (≥ 1024 px)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⚙ Configurações        Empresa X · Unidade Centro ▾        [⚠ 2 pendências] │
├───────────────────────┬──────────────────────────────────────────────────────┤
│ ▸ Unidade e empresa ● │  Fuso e horário de funcionamento        [Salvar]     │
│   Metas e operação    │  ┌ Fuso  America/Sao_Paulo ▾ ┐  origem: unidade     │
│   Notificações     ⚠  │  │ Seg–Sex 08:00–23:00  Sáb …│                     │
│   Usuários e acesso   │  └───────────────────────────┘                     │
│   Integrações         │  ● Alterações não salvas · [Descartar] [Salvar]      │
│   Segurança e priv.   │                                                      │
│   Preferências        │                                                      │
└───────────────────────┴──────────────────────────────────────────────────────┘
```

- **Navegação lateral fixa** (≈ 240 px), `nav` com lista e `aria-current="page"`. Setas ↑/↓ entre itens, Enter abre.
- **Cabeçalho com contexto:** a empresa e a unidade vêm do seletor existente. Seções "por unidade" mostram aviso quando o contexto é "todas as unidades" (reaproveita `avisoSemUnidade`).
- **Indicadores de pendência** por categoria (ponto/contador). Exemplos:
  - fuso não definido;
  - destinatário aguardando verificação;
  - consentimento a regularizar;
  - integração desconectada.

  O cálculo vem de uma rota única de resumo (doc 09), nunca de N chamadas.
- **Rota por seção** (`#configuracoes/notificacoes/destinatarios`): recarregar mantém a seção, e o atalho do Dashboard iFood vira um link real. Compatível com `abrirSecaoConfiguracoes(id)`.

### Celular (< 768 px)

- A lista de categorias vira a primeira tela. A seção abre em tela cheia com "← Configurações" e título. A busca entre seções é opcional.
- Formulários em uma coluna; ações primárias em barra inferior fixa (respeitando a área segura).
- Tabelas (histórico, destinatários) viram **lista de cartões** abaixo de 600 px, sem rolagem horizontal da página. Mesmo critério testado no Dashboard 2.0 a 390 px.

## 3. Padrões de formulário

| Padrão | Regra |
|---|---|
| **Estado de salvamento** | `limpo → alterado → salvando → salvo (carimbo "Salvo às 14:32") \| erro`. Barra fixa com Descartar/Salvar só quando alterado. Aviso ao sair com alterações (troca de seção ou de contexto). |
| **Validação** | No cliente (formato) e no servidor (fonte de verdade). Mensagem junto ao campo (`aria-describedby`), resumo no topo quando houver mais de um erro, foco no primeiro inválido. CNPJ, UF, e-mail, telefone E.164 com máscara de exibição. |
| **Permissão** | A seção mostra o que o usuário **pode fazer**. Sem permissão de edição: campos em leitura e faixa "Somente leitura — quem altera: Administrador da empresa". Ações proibidas **não aparecem** (corrige o defeito de Usuários). |
| **Ações críticas** | Diálogo `<dialog>` próprio (padrão da Ficha 360°), com título, consequência em linguagem simples, e confirmação digitada quando irreversível ou de alto impacto (ex.: remover destinatário de todas as unidades, trocar tabela oficial). Nunca `confirm()`. |
| **Erros** | Estado de erro com motivo e "Tentar de novo". Nunca apagar o que o usuário digitou. |
| **Vazios** | Explicam o próximo passo ("Nenhum destinatário. Adicione o primeiro para receber o aviso D-1"). |
| **Acessibilidade** | Contraste AA nos dois temas; alvo de toque ≥ 40 px; ícones com `aria-hidden` e texto visível; leitores de tela anunciam salvamento (`aria-live="polite"`). |
| **Consistência** | Ícones de `icons.js` (sem emoji); `pill ok/warn/bad/muted` para estados; mesma tipografia e espaçamentos do Dashboard 2.0; números de telefone sempre mascarados (`********01`). |

## 4. Menos espaço desperdiçado

- **Hoje:** a grade de 8 cartões ocupa a tela inteira só para navegar, e cada seção perde a navegação.
- **Proposta:** a navegação fica sempre visível, com conteúdo em painéis compactos (`cfg-panel`), formulários em grade de 2 colunas no desktop e resumo de estado no topo de cada categoria.

## 5. Componentes reaproveitados

`cfg-panel`, `cfg-form-grid`, `cfg-campo`, `pill`, `btn`, `estado`/`spinner`, `toast` (só para confirmação leve) e `icon()`. Do Dashboard 2.0 vêm o padrão de abas com teclado e o restauro de foco por `id` (corrigido no PR #54), `estadoCarga` e `dialog` + devolução de foco. Os seletores de contexto e `carregarProtegido` (proteção contra troca de contexto durante `await`) continuam.

## 6. Protótipo documental — Notificações → Destinatários

```
Destinatários desta unidade (Centro)                     [+ Adicionar destinatário]
────────────────────────────────────────────────────────────────────────────────
● Ana (Gerente)     ********01   Ativo            D-1 ✓  Fechamento ✓   [⋯]
● João (Dono)       ********02   Verificado, sem consentimento → [Reenviar convite]
○ Marta (Fin.)      ********07   Suspenso (pela unidade em 12/11)        [⋯]
────────────────────────────────────────────────────────────────────────────────
ⓘ Destinatários da empresa que recebem de TODAS as unidades: 1 (ver)
```
