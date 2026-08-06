const express = require("express");
const { saveSnapshot } = require("../services/ticket.service");

const router = express.Router();

router.post("/snapshot", (req, res, next) => {
  try {
    validateExtensionToken(req);
    const result = saveSnapshot(req.body);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

function validateExtensionToken(req) {
  const expected = process.env.EXTENSION_TOKEN;
  if (!expected) {
    return;
  }

  if (req.get("x-extension-token") !== expected) {
    const error = new Error("Token da extensao invalido");
    error.statusCode = 401;
    error.publicMessage = "Token da extensao invalido";
    throw error;
  }
}

module.exports = router;

