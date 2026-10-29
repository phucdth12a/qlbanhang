// Bảng dòng động: thêm/xoá dòng theo <template data-line-template>
document.querySelectorAll('[data-lines]').forEach((wrap) => {
  const tbody = wrap.querySelector('tbody[data-lines-body]');
  const tpl = wrap.querySelector('template[data-line-template]');
  let next = tbody.querySelectorAll('tr').length;
  wrap.querySelectorAll('[data-add-line]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const html = tpl.innerHTML.replace(/__i__/g, String(next++));
      tbody.insertAdjacentHTML('beforeend', html);
      const row = tbody.lastElementChild;
      filterLocations(row);
      row.querySelector('select, input')?.focus();
      wrap.dispatchEvent(new Event('input', { bubbles: true }));
    })
  );
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-line]');
    if (!btn) return;
    if (tbody.querySelectorAll('tr').length <= 1) return;
    btn.closest('tr').remove();
    wrap.dispatchEvent(new Event('input', { bubbles: true }));
  });
});

// Xác nhận trước khi bấm nút quan trọng
document.addEventListener('submit', (e) => {
  const btn = e.submitter;
  const msg = btn?.dataset.confirm || e.target.dataset.confirm;
  if (msg && !window.confirm(msg)) e.preventDefault();
});

// Ô chọn vị trí chỉ hiện vị trí thuộc kho đang chọn
const whSelect = document.querySelector('[data-warehouse-select]');
function filterLocations(scope = document) {
  if (!whSelect) return;
  const wh = whSelect.value;
  scope.querySelectorAll('select[data-location-select]').forEach((sel) => {
    sel.querySelectorAll('option[data-warehouse]').forEach((opt) => {
      const show = opt.dataset.warehouse === wh;
      opt.hidden = !show;
      opt.disabled = !show;
      if (!show && opt.selected) sel.value = '';
    });
  });
}
if (whSelect) {
  whSelect.addEventListener('change', () => filterLocations());
  filterLocations();
}

// Tính thành tiền phiếu mua hàng
const poForm = document.querySelector('[data-po-form]');
if (poForm) {
  const nf = new Intl.NumberFormat('vi-VN');
  const recalc = () => {
    let sub = 0;
    let tax = 0;
    poForm.querySelectorAll('tbody[data-lines-body] tr').forEach((tr) => {
      const q = parseFloat(tr.querySelector('[data-qty]')?.value) || 0;
      const p = parseFloat(tr.querySelector('[data-price]')?.value) || 0;
      const t = parseFloat(tr.querySelector('[data-tax]')?.value) || 0;
      const line = q * p;
      sub += line;
      tax += (line * t) / 100;
      const out = tr.querySelector('[data-line-total]');
      if (out) out.textContent = nf.format(Math.round(line));
    });
    poForm.querySelector('[data-subtotal]').textContent = nf.format(Math.round(sub)) + ' ₫';
    poForm.querySelector('[data-taxtotal]').textContent = nf.format(Math.round(tax)) + ' ₫';
    poForm.querySelector('[data-grandtotal]').textContent = nf.format(Math.round(sub + tax)) + ' ₫';
  };
  poForm.addEventListener('input', recalc);
  poForm.addEventListener('change', (e) => {
    // chọn biến thể -> điền giá vốn gợi ý nếu ô giá đang trống
    const sel = e.target.closest('[data-variant]');
    if (sel) {
      const price = sel.selectedOptions[0]?.dataset.cost;
      const input = sel.closest('tr').querySelector('[data-price]');
      if (price && input && !input.value) input.value = price;
    }
    recalc();
  });
  recalc();
}
