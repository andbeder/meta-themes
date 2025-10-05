
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { create } = require('xmlbuilder2');
const { SignedXml } = require('xml-crypto');

/**
 * Authenticate to Okta using the SAML bearer assertion flow.
 */
async function authenticate() {
  const debug = process.env.SFDC_AUTH_DEBUG === '1';
  const clientId = process.env.SFDC_CLIENT_ID;
  const username = process.env.SFDC_USERNAME || 'andbeder@salesforce.com';
  const keyPath = process.env.SFDC_PRIVATE_KEY || '../jwt.key.enc';
  const keyPass = process.env.KEY_PASS;
  const tokenUrl = process.env.SFDC_TOKEN_URL ||
    'https://login.salesforce.com/services/oauth2/token';

  const issuer = 'http://www.okta.com/exk15s2iykjsdT23u2p8';
  const recipient = 'https://mcic.okta.com/app/mcic_asdf_2/exk15s2iykjsdT23u2p8/sso/saml';
  const audience = recipient;

  if (debug) {
    console.log('SFDC auth debug info:');
    console.log('  tokenUrl:', tokenUrl);
    console.log('  username:', username);
    console.log('  clientId:', clientId);
    console.log('  using PBKDF2:', process.env.KEY_PBKDF2 === '1');
  }

  if (!clientId || !keyPath) {
    throw new Error('SFDC_CLIENT_ID and SFDC_PRIVATE_KEY must be set');
  }

  if (!keyPass) {
    throw new Error('KEY_PASS must be set');
  }

  const usePbkdf2 = process.env.KEY_PBKDF2 === '1';
  const privateKey = decryptKey(
    fs.readFileSync(path.resolve(keyPath)),
    keyPass,
    usePbkdf2
  ).toString('utf8');

  const assertion = buildSamlAssertion({
    issuer,
    subject: username,
    recipient,
    audience,
    privateKey,
  });

  if (debug) {
    console.log('  saml assertion:', assertion);
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'urn:ietf:params:oauth:grant-type:saml2-bearer');
  params.append('assertion', Buffer.from(assertion).toString('base64'));

  if (debug) {
    console.log('  request body:', params.toString());
  }

  let data;
  try {
    const resp = await axios.post(tokenUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    data = resp.data;
  } catch (err) {
    if (debug && err.response) {
      console.error('  status:', err.response.status);
      console.error('  response:', err.response.data);
    }
    throw err;
  }

  if (debug) {
    console.log('  accessToken:', data.access_token);
    console.log('  instanceUrl:', data.instance_url);
  }

  return {
    accessToken: data.access_token,
    instanceUrl: data.instance_url,
  };
}

if (require.main === module) {
  authenticate()
    .then(res => console.log(res))
    .catch(err => {
      if (err.response && err.response.data) {
        console.error(err.response.data);
      } else {
        console.error(err.message);
      }
      process.exit(1);
    });
}

module.exports = authenticate;

function buildSamlAssertion({ issuer, subject, recipient, audience, privateKey }) {
  const id = '_' + crypto.randomBytes(20).toString('hex');
  const issueInstant = new Date().toISOString();
  const notOnOrAfter = new Date(Date.now() + 3 * 60 * 1000).toISOString();

  const assertionObj = {
    'saml:Assertion': {
      '@xmlns:saml': 'urn:oasis:names:tc:SAML:2.0:assertion',
      '@ID': id,
      '@Version': '2.0',
      '@IssueInstant': issueInstant,
      'saml:Issuer': issuer,
      'saml:Subject': {
        'saml:NameID': subject,
        'saml:SubjectConfirmation': {
          '@Method': 'urn:oasis:names:tc:SAML:2.0:cm:bearer',
          'saml:SubjectConfirmationData': {
            '@Recipient': recipient,
            '@NotOnOrAfter': notOnOrAfter,
          },
        },
      },
      'saml:Conditions': {
        '@NotBefore': issueInstant,
        '@NotOnOrAfter': notOnOrAfter,
        'saml:AudienceRestriction': { 'saml:Audience': audience },
      },
    },
  };

  let xml = create(assertionObj).end({ headless: true });
  const sig = new SignedXml({ privateKey });
  sig.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  sig.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.getKeyInfoContent = () => '<X509Data></X509Data>';
  sig.computeSignature(xml);
  return sig.getSignedXml();
}

function decryptKey(buf, pass, usePbkdf2) {
  const magic = Buffer.from('Salted__');
  if (buf.slice(0, magic.length).compare(magic) !== 0) {
    throw new Error('Invalid encrypted key file');
  }
  const salt = buf.slice(magic.length, magic.length + 8);
  const enc = buf.slice(magic.length + 8);

  let key, iv;
  if (usePbkdf2) {
    const derived = crypto.pbkdf2Sync(
      Buffer.from(pass, 'utf8'),
      salt,
      10000,
      48,
      'sha256'
    );
    key = derived.slice(0, 32);
    iv = derived.slice(32, 48);
  } else {
    ({ key, iv } = evpKdf(Buffer.from(pass, 'utf8'), salt, 32, 16));
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function evpKdf(password, salt, keyLen, ivLen) {
  let data = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (data.length < keyLen + ivLen) {
    const md5 = crypto.createHash('md5');
    md5.update(Buffer.concat([prev, password, salt]));
    prev = md5.digest();
    data = Buffer.concat([data, prev]);
  }
  return {
    key: data.slice(0, keyLen),
    iv: data.slice(keyLen, keyLen + ivLen),
  };
}
