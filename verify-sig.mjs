import { verifyMessage } from 'viem';

const address = '0x50871F14F7ba0141766d3079ACDA9ecE2F5AB41E';
const nonce = 'b06cf2cb43f52010d8a38c9db67c3e8eab98cea1efd3750d094b6d1ccfdb6db7';
const ts = '1770373009272';
const qh = '86b11458c0300cba96ae1007340ae4b33cb296829862201539106423676cb4b9';

const message = `I am querying slop.money agent API\n\nWallet: ${address}\nNonce: ${nonce}\nTimestamp: ${ts}\nQueryHash: ${qh}`;
const signature = '0x590ac6f0e3d1e6dc8f8f47ef147210f9f5117290549654be4c340c60615bde2b7e8750aede592ae5333e50ff30ea6ee51fbe7ac3f27784c85c93dc35cc9ad2c91c';

console.log('msg hex:', Buffer.from(message).toString('hex'));
const valid = await verifyMessage({ address, message, signature });
console.log('valid:', valid);
