// Power BI Governance App - Client-side utilities
document.addEventListener('DOMContentLoaded', () => {
  // Auto-dismiss flash alerts after 5 seconds
  document.querySelectorAll('.alert-dismissible').forEach((alert) => {
    setTimeout(() => {
      alert.classList.remove('show');
      setTimeout(() => alert.remove(), 300);
    }, 5000);
  });

  // Collapsible sections: toggle collapse on click
  document.querySelectorAll('.section-toggle').forEach((el) => {
    el.addEventListener('click', () => {
      el.classList.toggle('collapsed');
      const target = document.querySelector(el.getAttribute('data-target'));
      if (target) target.classList.toggle('d-none');
    });
  });
});
