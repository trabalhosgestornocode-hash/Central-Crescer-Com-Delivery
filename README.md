# Central Crescer com Delivery

Plataforma de gestão, inteligência operacional e análise de performance desenvolvida para centralizar os principais processos da **Crescer com Delivery**.

A Central Crescer com Delivery foi criada para transformar dados operacionais em decisões mais rápidas, organizadas e confiáveis, reunindo em um único ambiente informações de desempenho, financeiro, conciliação, gestão de unidades, acompanhamento operacional e inteligência aplicada ao delivery.

---

## Sobre a plataforma

A **Central Crescer com Delivery** funciona como o núcleo tecnológico da operação.

O sistema foi desenvolvido para permitir o acompanhamento de múltiplas empresas e unidades, mantendo separação de dados, controle de acesso e uma visão consolidada da operação.

A plataforma busca eliminar controles descentralizados, planilhas paralelas e análises manuais, criando uma fonte central para acompanhamento da operação.

Entre os principais objetivos estão:

* Centralizar informações operacionais.
* Acompanhar indicadores de performance.
* Monitorar resultados financeiros.
* Identificar desvios e oportunidades.
* Automatizar processos internos.
* Melhorar a tomada de decisão.
* Organizar empresas e unidades em uma estrutura multiempresa.
* Criar inteligência sobre os dados da operação.

---

# Principais módulos

## Dashboard Executivo

Área destinada à visão consolidada da operação.

Permite acompanhar os principais indicadores do negócio, incluindo desempenho, faturamento, custos, clientes, operação diária e demais informações estratégicas.

O objetivo é permitir que gestores identifiquem rapidamente:

* evolução da operação;
* desvios de indicadores;
* pontos críticos;
* oportunidades de melhoria;
* comportamento financeiro;
* performance das unidades.

---

## Dashboard iFood

Módulo dedicado ao acompanhamento da operação dentro do iFood.

Centraliza informações relevantes do canal e auxilia no monitoramento diário dos principais indicadores relacionados às vendas e deduções da plataforma.

Entre os indicadores analisados estão:

* faturamento;
* taxas e comissões;
* serviços e promoções;
* taxas de entregadores;
* deduções;
* novos clientes;
* conversão;
* desempenho diário.

O sistema também trabalha com regras de acompanhamento e limites operacionais para facilitar a identificação de situações que exigem atenção.

---

## Financeiro

Central de acompanhamento financeiro da operação.

Permite visualizar e consolidar informações relacionadas a receitas, despesas, ajustes e demais movimentações financeiras.

O módulo foi estruturado para facilitar a leitura dos números e melhorar a confiabilidade dos dados utilizados nas análises gerenciais.

---

## Parser Food Delivery

Ferramenta responsável pela leitura e interpretação de relatórios operacionais.

O Parser Food Delivery permite importar relatórios e transformar seus dados em informações estruturadas para análise dentro da plataforma.

Entre seus recursos estão:

* importação de relatórios;
* identificação automática do período;
* consolidação por intervalo de datas;
* análise de pedidos;
* acompanhamento de cancelamentos;
* detalhamento das ocorrências;
* histórico de importações;
* conciliação de informações.

---

## Central de Conciliação

Área destinada à identificação e análise de divergências operacionais e financeiras.

O objetivo é facilitar a conferência dos dados provenientes das plataformas de delivery e permitir que inconsistências sejam identificadas com maior rapidez.

---

## Bonificação Mensal

Módulo responsável pelo acompanhamento e cálculo dos indicadores utilizados na bonificação operacional.

A arquitetura prioriza uma fonte oficial de dados e mecanismos de fechamento mensal para garantir maior consistência entre os números apresentados e os relatórios utilizados pela operação.

O módulo permite:

* acompanhamento de indicadores;
* visualização das faixas de bonificação;
* análise da evolução dos resultados;
* fechamento mensal;
* histórico das competências;
* rastreabilidade das informações.

---

## Plano de Ação

O Plano de Ação transforma os indicadores da plataforma em direcionamentos operacionais.

Em vez de apenas indicar que determinado número está fora da meta, o sistema busca apresentar o que deve ser acompanhado ou corrigido.

Os indicadores podem ser classificados de acordo com seu cenário operacional, permitindo priorizar ações críticas, pontos de atenção e indicadores saudáveis.

---

## Central de Performance

Área destinada à análise estratégica das unidades.

Permite comparar comportamento de faturamento, custos, lucratividade, clientes, conversão e demais indicadores relevantes.

Seu objetivo é ajudar a responder perguntas como:

* Por que determinada unidade perdeu faturamento?
* Quais custos estão pressionando a lucratividade?
* Qual unidade apresenta melhor evolução?
* Onde existem oportunidades de crescimento?
* Quais indicadores precisam de intervenção?

---

## Painel Administrativo

Ambiente administrativo responsável pelo acompanhamento global da plataforma.

Permite que usuários autorizados monitorem empresas, unidades, acessos e processos internos da operação.

Entre suas funcionalidades estão:

* acompanhamento das unidades;
* monitoramento de lançamentos;
* gestão de acessos;
* administração de empresas;
* controle operacional;
* acompanhamento de pendências;
* gestão das demandas de desenvolvimento.

---

## Agenda de Demandas

Área utilizada para organizar a evolução da própria plataforma.

Permite registrar demandas, responsáveis, prioridades, status e histórico das alterações.

A Agenda de Demandas funciona como uma central interna de acompanhamento do desenvolvimento da Central Crescer com Delivery.

---

## Inteligência e Agente

A camada de inteligência da plataforma foi criada para transformar dados consolidados em análises mais acessíveis.

O objetivo do Agente é permitir consultas sobre a operação e ajudar gestores a interpretar indicadores, identificar possíveis causas de problemas e encontrar oportunidades de melhoria.

---

# Estrutura multiempresa

A Central Crescer com Delivery foi projetada para operar em um ambiente com múltiplas empresas e unidades.

A estrutura permite trabalhar com:

```text
Plataforma
│
├── Empresa
│   ├── Unidade 01
│   ├── Unidade 02
│   └── Unidade 03
│
├── Empresa
│   └── Unidade 01
│
└── Empresa
    ├── Unidade 01
    └── Unidade 02
```

Cada usuário recebe acesso somente às empresas, unidades e módulos autorizados.

Essa estrutura permite que a plataforma cresça sem misturar informações entre operações diferentes.

---

# Controle de acesso

A plataforma possui diferentes níveis de acesso e permissões.

O sistema considera fatores como:

* usuário;
* perfil;
* empresa;
* unidade;
* módulo;
* permissões administrativas.

Essa estrutura permite controlar com precisão quais informações e funcionalidades cada pessoa pode acessar.

---

# Filosofia do produto

A Central Crescer com Delivery não foi criada apenas para exibir dashboards.

O objetivo é construir um sistema capaz de conectar:

```text
DADOS
  ↓
INFORMAÇÃO
  ↓
ANÁLISE
  ↓
DECISÃO
  ↓
AÇÃO
  ↓
RESULTADO
```

Cada módulo deve contribuir para reduzir trabalhos manuais e tornar a operação mais previsível, organizada e orientada por dados.

---

# Princípios da plataforma

### Fonte única de informação

Sempre que possível, cada indicador deve possuir uma origem oficial e rastreável.

### Isolamento de dados

Informações de empresas e unidades diferentes não devem ser misturadas.

### Rastreabilidade

Alterações importantes devem possuir histórico e contexto.

### Automação

Processos repetitivos devem ser automatizados sempre que houver confiabilidade suficiente para isso.

### Clareza operacional

O sistema deve mostrar não apenas o que aconteceu, mas ajudar o usuário a entender o que precisa ser feito.

### Escalabilidade

Novas empresas e unidades devem poder ser adicionadas sem comprometer a organização da plataforma.

---

# Visão de arquitetura

De forma simplificada, a Central segue a seguinte estrutura:

```text
Frontend
   │
   ▼
API / Backend
   │
   ├── Autenticação
   ├── Permissões
   ├── Regras de negócio
   ├── Módulos operacionais
   └── Serviços
   │
   ▼
Banco de Dados
   │
   ├── Empresas
   ├── Unidades
   ├── Usuários
   ├── Indicadores
   ├── Financeiro
   ├── Relatórios
   ├── Histórico
   └── Auditoria
```

---

# Segurança

A segurança da plataforma é tratada como parte da arquitetura do produto.

Entre os conceitos utilizados estão:

* autenticação;
* autorização por contexto;
* separação entre empresas e unidades;
* validação de permissões;
* proteção de rotas;
* auditoria;
* políticas de acesso no banco;
* controle de sessões.

Novas funcionalidades devem preservar esses princípios.

---

# Desenvolvimento

Antes de implementar novas funcionalidades, deve-se considerar:

1. impacto em empresas e unidades;
2. isolamento multiempresa;
3. permissões necessárias;
4. impacto no banco de dados;
5. necessidade de migrations;
6. compatibilidade com funcionalidades existentes;
7. testes;
8. experiência do usuário;
9. segurança;
10. rastreabilidade.

---

# Migrations

Alterações estruturais de banco de dados devem ser realizadas através de migrations versionadas.

Nunca alterar o schema de produção manualmente sem que exista uma migration correspondente no projeto.

---

# Testes

Mudanças relevantes devem possuir cobertura de testes sempre que aplicável.

Prioridades:

* regras de negócio;
* isolamento entre empresas;
* permissões;
* cálculos financeiros;
* parsers;
* endpoints;
* regressões de funcionalidades existentes.

---

# Padrão de interface

A interface da Central Crescer com Delivery deve seguir uma identidade consistente.

Diretrizes principais:

* visual profissional;
* interface limpa;
* hierarquia clara;
* alinhamento consistente;
* ausência de elementos visuais desnecessários;
* experiência orientada a dados;
* responsividade;
* navegação simples;
* identidade visual da Crescer com Delivery.

---

# Evolução da plataforma

A Central Crescer com Delivery está em desenvolvimento contínuo.

Cada nova funcionalidade deve contribuir para um dos principais objetivos da plataforma:

**automatizar, organizar, analisar ou melhorar a operação.**

A evolução do sistema deve priorizar confiabilidade, escalabilidade e qualidade das informações.

---

# Central Crescer com Delivery

**Tecnologia aplicada à gestão de operações de delivery.**

Dados centralizados.
Operações organizadas.
Decisões mais inteligentes.
