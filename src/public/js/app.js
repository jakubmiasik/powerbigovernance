// Power BI Governance App - Client-side utilities
document.addEventListener('DOMContentLoaded', () => {
  // Auto-dismiss flash alerts after 5 seconds
  document.querySelectorAll('.alert-dismissible').forEach((alert) => {
    setTimeout(() => {
      alert.classList.remove('show');
      setTimeout(() => alert.remove(), 300);
    }, 5000);
  });
});
