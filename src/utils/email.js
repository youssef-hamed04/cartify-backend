import nodemailer from 'nodemailer';

const createTransporter = () =>
  nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_SENDER, pass: process.env.EMAIL_SENDER_PASSWORD },
  });

export const sendEmail = async (to, subject, html) => {
  try {
    const info = await createTransporter().sendMail({
      from: `"Cartify" <${process.env.EMAIL_SENDER}>`,
      to, subject, html,
    });
    return info.accepted.length > 0;
  } catch (err) {
    console.error('📧  Email send failed:', err.message);
    return false;
  }
};

export const generateOrderConfirmationHtml = (order) => {
  const rows = order.products.map((item) => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #eee;">${item.name}</td>
      <td style="padding:10px;border-bottom:1px solid #eee;text-align:center;">${item.color}</td>
      <td style="padding:10px;border-bottom:1px solid #eee;text-align:center;">${item.quantity}</td>
      <td style="padding:10px;border-bottom:1px solid #eee;text-align:right;">${(item.unitPrice * item.quantity).toFixed(2)} EGP</td>
    </tr>`).join('');

  return `
  <div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:8px;overflow:hidden;">
    <div style="background:#02067e;padding:24px;text-align:center;">
      <h1 style="margin:0;color:#fff;font-size:22px;">Order Confirmed ✔</h1>
      <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);">Order #${order.randomId}</p>
    </div>
    <div style="padding:24px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#f9f9f9;">
          <th style="padding:10px;text-align:left;">Product</th>
          <th style="padding:10px;text-align:center;">Color</th>
          <th style="padding:10px;text-align:center;">Qty</th>
          <th style="padding:10px;text-align:right;">Total</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table style="width:100%;margin-top:20px;border-collapse:collapse;">
        <tr><td style="padding:8px;text-align:right;color:#666;">Subtotal</td><td style="padding:8px;text-align:right;">${order.subtotal.toFixed(2)} EGP</td></tr>
        <tr><td style="padding:8px;text-align:right;color:#666;">Shipping</td><td style="padding:8px;text-align:right;">${order.shippingCost.toFixed(2)} EGP</td></tr>
        <tr style="font-weight:bold;border-top:2px solid #eee;">
          <td style="padding:10px;text-align:right;">Total</td>
          <td style="padding:10px;text-align:right;color:#02067e;font-size:18px;">${order.totalPrice.toFixed(2)} EGP</td>
        </tr>
      </table>
    </div>
    <div style="padding:20px;text-align:center;font-size:13px;color:#888;">
      Thank you for shopping with Cartify 💙
    </div>
  </div>`;
};
