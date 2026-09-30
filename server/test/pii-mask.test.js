// Mascaramento de dados pessoais (services/pii-mask.js).
//
// So dados FICTICIOS: os documentos abaixo sao exemplos de DV valido
// conhecidos, os telefones e enderecos sao inventados. O repositorio e publico.

const test = require("node:test");
const assert = require("node:assert/strict");
const { assertNoPii, isValidCnpj, isValidCpf, maskText } = require("../src/services/pii-mask");

// [texto cru, marcador esperado, trechos que nao podem sobrar]
const MUST_MASK = [
  ["123.456.789-09", "[CPF]", ["123", "789"]],
  ["12345678909", "[CPF]", ["12345678909"]],
  ["11.222.333/0001-81", "[CNPJ]", ["222", "0001"]],
  ["11222333000181", "[CNPJ]", ["11222333000181"]],
  ["12.ABC.345/01DE-35", "[CNPJ]", ["ABC", "01DE"]],
  ["12abc34501de35", "[CNPJ]", ["abc345"]],
  ["123.456.789-00", "[CPF]", ["456"]],
  ["85999998888", "[TELEFONE]", ["99999"]],
  ["(85) 9 8888-7777", "[TELEFONE]", ["8888", "7777"]],
  ["CEP 60000-000", "[CEP]", ["60000"]],
  ["4111 1111 1111 1111", "[CARTAO]", ["4111"]],
  ["senha do wifi: abc12345", "[SENHA]", ["abc12345"]],
  ["pppoe: cliente123", "[SENHA]", ["cliente123"]],
  ["Rua das Acacias, 123, apto 45, bairro Centro", "[ENDERECO]", ["Acacias", "123", "45", "Centro"]],
  ["moro na av. brasil 1500 bloco b", "[ENDERECO]", ["brasil", "1500", "bloco b"]],
  ["fica na quadra 12 lote 7", "[ENDERECO]", ["quadra 12", "lote 7"]],
  ["Travessa Sao Jose s/n", "[ENDERECO]", ["Sao Jose", "s/n"]],
  ["https://maps.google.com/maps?q=-3.73,-38.52", "[LOCALIZACAO]", ["maps", "-3.73", "-38.52"]],
  ["IP 177.12.34.56", "[IP]", ["177.12"]],
  ["MAC AA:BB:CC:DD:EE:FF", "[EQUIPAMENTO]", ["AA:BB"]]
];

const MUST_KEEP = [
  "vou pagar via pix",
  "estou em casa",
  "plano de 500 mega",
  "R$ 99,90",
  "dia 30/09 as 14:30",
  "protocolo 641422",
  "acesse 192.168.0.1",
  "reinicie o roteador"
];

test("digitos verificadores de CPF e CNPJ (numerico e alfanumerico)", () => {
  assert.equal(isValidCpf("123.456.789-09"), true);
  assert.equal(isValidCpf("12345678909"), true);
  assert.equal(isValidCpf("123.456.789-00"), false);
  assert.equal(isValidCpf("111.111.111-11"), false, "11 digitos iguais nao sao CPF");

  assert.equal(isValidCnpj("11.222.333/0001-81"), true);
  assert.equal(isValidCnpj("11222333000181"), true);
  assert.equal(isValidCnpj("11.222.333/0001-80"), false);
  assert.equal(isValidCnpj("12.ABC.345/01DE-35"), true);
  assert.equal(isValidCnpj("12abc34501de35"), true, "alfanumerico e normalizado para maiusculas");
  assert.equal(isValidCnpj("12.ABC.345/01DE-36"), false);
});

for (const [raw, marker, leftovers] of MUST_MASK) {
  test(`mascara: ${raw}`, () => {
    const { text, found } = maskText(raw);
    assert.ok(text.includes(marker), `esperava ${marker} em "${text}"`);
    for (const piece of leftovers) {
      assert.ok(!text.toLowerCase().includes(piece.toLowerCase()), `"${piece}" sobrou em "${text}"`);
    }
    // So a contagem sai do modulo, nunca o valor.
    assert.ok(Object.values(found).every((total) => Number.isInteger(total) && total > 0));
    assert.ok(!JSON.stringify(found).includes(raw));
  });

  test(`assertNoPii barra o cru e aceita o mascarado: ${raw}`, () => {
    assert.throws(
      () => assertNoPii(raw),
      (error) => {
        assert.ok(error.piiFound && Object.keys(error.piiFound).length);
        assert.ok(!error.message.includes(raw), "a mensagem de erro nao pode repetir o valor");
        return true;
      }
    );
    assert.doesNotThrow(() => assertNoPii(maskText(raw).text));
  });
}

for (const raw of MUST_KEEP) {
  test(`nao mascara: ${raw}`, () => {
    const { text, found } = maskText(raw);
    assert.equal(text, raw);
    assert.deepEqual(found, {});
    assert.doesNotThrow(() => assertNoPii(raw));
  });
}

test("CPF com DV invalido: o DV so escolhe o rotulo, nunca decide se mascara", () => {
  assert.equal(maskText("12345678900").text, "[NUMERO]");
  assert.equal(maskText("85999998888").text, "[TELEFONE]");
  assert.equal(maskText("123 456 789 09").text, "[CPF]");
});

test("endereco: mascara so o trecho e preserva o resto da frase", () => {
  assert.equal(maskText("pode mandar o tecnico na rua tal 45 amanha?").text, "pode mandar o tecnico na [ENDERECO] amanha?");
  assert.equal(maskText("Rua 7 de Setembro, 120").text, "[ENDERECO]");
  assert.equal(maskText("moro na Rua A, 45").text, "moro na [ENDERECO]");
  assert.equal(maskText("Av Beira Mar 3000 apto 1202 bloco C bairro Meireles, Fortaleza").text, "[ENDERECO], Fortaleza");
  assert.equal(maskText("rodovia CE 040 km 12").text, "[ENDERECO]");
  // Complemento solto tambem e endereco.
  assert.equal(maskText("apto 302").text, "[ENDERECO]");
  assert.equal(maskText("bloco B").text, "[ENDERECO]");
  assert.equal(maskText("casa 5").text, "[ENDERECO]");
  assert.equal(maskText("no bairro Jose Walter").text, "no [ENDERECO]");
});

test("endereco: palavra ambigua sem numero de casa fica intacta", () => {
  for (const raw of [
    "estou na rua esperando o tecnico",
    "estou em casa ha 2 dias",
    "via pix 3 parcelas",
    "minha tv samsung 50 polegadas",
    "a tv nao liga",
    "plano residencial 300 mega",
    "o bairro todo esta sem internet",
    "qual seu bairro?"
  ]) {
    assert.equal(maskText(raw).text, raw);
  }
});

test("credenciais: com dois-pontos sempre; sem eles so o que parece segredo", () => {
  assert.equal(maskText("login: fulano.silva").text, "login: [SENHA]");
  assert.equal(maskText("a senha e minhacasa").text, "a senha e [SENHA]");
  assert.equal(maskText("senha e Abc@2024").text, "senha e [SENHA]");
  assert.equal(maskText("a senha nao funciona").text, "a senha nao funciona");
  assert.equal(maskText("a senha e muito dificil").text, "a senha e muito dificil");
});

test("deteccao tolera acento e maiusculas", () => {
  assert.equal(maskText("Agência 1234").text, "Agência [CONTA_BANCARIA]");
  assert.equal(maskText("Praça da Sé, 45").text, "[ENDERECO]");
  assert.equal(maskText("SENHA DO WI-FI: Xy12ab").text, "SENHA DO WI-FI: [SENHA]");
});

test("demais detectores", () => {
  assert.equal(maskText("meu email e Fulano.Tal@Exemplo.com.br").text, "meu email e [EMAIL]");
  assert.equal(maskText("+55 85 99999-8888").text, "[TELEFONE]");
  assert.equal(maskText("cvv 123").text, "cvv [CARTAO]");
  assert.equal(maskText("agencia 1234 conta 12345-6").text, "agencia [CONTA_BANCARIA] conta [CONTA_BANCARIA]");
  assert.equal(maskText("chave pix 123e4567-e89b-12d3-a456-426614174000").text, "chave pix [CHAVE_PIX]");
  assert.equal(maskText("meu RG e 12.345.678-9").text, "meu RG e [RG]");
  assert.equal(maskText("data de nascimento: 15/03/1985").text, "data de nascimento: [DATA_NASCIMENTO]");
  assert.equal(maskText("dia 15/03 as 10h").text, "dia 15/03 as 10h");
  assert.equal(maskText("IPv6 2804:14c:1234:5678::1").text, "IPv6 [IP]");
  assert.equal(maskText("gateway 10.0.0.1 e mascara 255.255.255.0").text, "gateway 10.0.0.1 e mascara 255.255.255.0");
  assert.equal(maskText("serial ZTEGC1234ABC").text, "serial [EQUIPAMENTO]");
  assert.equal(maskText("lat -3.7319, -38.5267").text, "lat [LOCALIZACAO]");
  assert.equal(maskText("protocolo 20260930123456").text, "protocolo [NUMERO]");
});

test("nome do cliente e do atendente viram marcador", () => {
  const options = { clientName: "Maria da Silva", attendantNames: ["Gabriel Oliveira"] };
  assert.equal(maskText("Maria da Silva disse ola, maria", options).text, "[CLIENTE] disse ola, [CLIENTE]");
  assert.equal(maskText("aqui e o Gabriel", options).text, "aqui e o [ATENDENTE]");
  // Tabela fixa de attendant-filter.js entra sempre, mesmo sem a lista.
  assert.equal(maskText("fala com a Stephanie").text, "fala com a [ATENDENTE]");
  // Conectivo do nome nao vira marcador em outra frase.
  assert.equal(maskText("a maioria das pessoas", { clientName: "Joana das Neves" }).text, "a maioria das pessoas");
});

test("assertNoPii confere payload JSON campo a campo", () => {
  const limpo = { mensagens: [{ id: "m1", autor: "CLIENTE", minuto: 0, texto: "meu cpf e [CPF], moro na [ENDERECO]" }] };
  assert.doesNotThrow(() => assertNoPii(JSON.stringify(limpo)));

  const sujo = { mensagens: [{ id: "m1", autor: "CLIENTE", minuto: 0, texto: "meu cpf e 123.456.789-09" }] };
  assert.throws(
    () => assertNoPii(JSON.stringify(sujo)),
    (error) => error.piiFound.CPF === 1 && !error.message.includes("123.456")
  );
});

test("mascarar duas vezes da o mesmo resultado", () => {
  for (const [raw] of MUST_MASK) {
    const once = maskText(raw).text;
    assert.equal(maskText(once).text, once);
  }
});
