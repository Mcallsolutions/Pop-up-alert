// Apresentacao do "padrao de atendimento" (porcentagem que junta TAG e
// inatividade, calculada na API em service-standard.js).

// null = nao ha ticket para avaliar: "-" e nao "0%".
export function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return `${String(Number(value)).replace(".", ",")}%`;
}

// Cor do cartao: 90% ou mais esta dentro do padrao; abaixo de 70% e critico.
export function standardTone(value) {
  if (value === null || value === undefined) return "default";
  if (value >= 90) return "success";
  if (value >= 70) return "warning";
  return "danger";
}

// Explica a conta na tela, com os numeros que a API usou.
export function describeStandard(standard) {
  const limit = standard?.thresholdMinutes || 15;
  const zero = standard?.zeroMinutes || limit * 4;
  const tagWeight = standard?.tagWeight ?? 50;
  const inactivityWeight = standard?.inactivityWeight ?? 50;
  return (
    `100% e a base. Cada ticket vale ${inactivityWeight}% pela inatividade e ${tagWeight}% pela TAG ` +
    `(ticket sem atendente so conta pela inatividade). Ate ${limit} min parado nao desconta; depois disso a nota cai ` +
    `de forma proporcional ate zerar em ${zero} min. Sem TAG, a parte da TAG vale 0.`
  );
}
