export function localDateValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function defaultReturnDate() {
  const date = new Date()
  date.setDate(date.getDate() + 14)
  return localDateValue(date)
}
