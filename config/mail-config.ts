const noReplyAccPassword = Deno.env.get('MAIL_NO_REPLY_PASSWORD')
if (!noReplyAccPassword) {
  throw new Error('MAIL_NO_REPLY_PASSWORD is not set in deno.env')
}

const emailSettings = {
  host: 'smtp.gmail.com',
  port: 465,
  secure: true, // implicit TLS — denomailer's STARTTLS negotiation on 587 has a known bug
  noReplyUserName: 'noreply@cheltsec.vic.edu.au',
  noReplyAccPassword,
}

export default emailSettings
