export function dmtvRadioAuthorization(ticket, creatorTx, fundTx) {
  return `DecentBusking DMTv main-radio queue (Base 8453)\nCheckout: ${ticket}\nCreator payment: ${creatorTx}\nPlayback fund deposit: ${fundTx}`;
}
