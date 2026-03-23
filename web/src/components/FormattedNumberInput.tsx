import type { InputHTMLAttributes } from 'react'
import { useEffect, useState } from 'react'

interface FormattedNumberInputProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'type' | 'value' | 'onChange' | 'inputMode'
  > {
  value: number | null
  onValueChange: (value: number | null) => void
  allowEmpty?: boolean
  allowDecimal?: boolean
  useGrouping?: boolean
}

const sanitizeNumericInput = (value: string, allowDecimal: boolean) => {
  const stripped = value.replace(/,/g, '').replace(/[^\d.-]/g, '')
  const negative = stripped.startsWith('-')
  const unsigned = stripped.replace(/-/g, '')
  const [integerPart = '', ...decimalParts] = unsigned.split('.')
  const decimalPart = allowDecimal ? decimalParts.join('') : ''
  const hasDecimal = allowDecimal && unsigned.includes('.')
  const normalizedInteger = integerPart.replace(/^0+(?=\d)/, '')

  return `${negative ? '-' : ''}${normalizedInteger}${hasDecimal ? `.${decimalPart}` : ''}`
}

const formatNumericInput = (value: string, useGrouping: boolean) => {
  if (value === '' || value === '-') {
    return value
  }

  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const hasTrailingDecimal = unsigned.endsWith('.')
  const [integerPart = '', decimalPart = ''] = unsigned.split('.')
  const displayInteger = useGrouping
    ? (integerPart || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : integerPart || '0'

  if (hasTrailingDecimal) {
    return `${negative ? '-' : ''}${displayInteger}.`
  }

  if (decimalPart !== '') {
    return `${negative ? '-' : ''}${displayInteger}.${decimalPart}`
  }

  return `${negative ? '-' : ''}${displayInteger}`
}

const formatFromNumber = (value: number | null, useGrouping: boolean) =>
  value === null ? '' : formatNumericInput(String(value), useGrouping)

export function FormattedNumberInput({
  value,
  onValueChange,
  allowEmpty = false,
  allowDecimal = true,
  useGrouping = true,
  ...props
}: FormattedNumberInputProps) {
  const [draft, setDraft] = useState(() => formatFromNumber(value, useGrouping))

  useEffect(() => {
    setDraft(formatFromNumber(value, useGrouping))
  }, [useGrouping, value])

  return (
    <input
      {...props}
      type="text"
      inputMode={allowDecimal ? 'decimal' : 'numeric'}
      value={draft}
      onChange={(event) => {
        const sanitized = sanitizeNumericInput(event.target.value, allowDecimal)
        setDraft(formatNumericInput(sanitized, useGrouping))

        if (sanitized === '') {
          if (allowEmpty) {
            onValueChange(null)
          }
          return
        }

        if (
          sanitized === '-' ||
          sanitized === '.' ||
          sanitized === '-.' ||
          sanitized.endsWith('.')
        ) {
          return
        }

        const nextValue = Number(sanitized)
        if (Number.isFinite(nextValue)) {
          onValueChange(nextValue)
        }
      }}
      onBlur={() => {
        setDraft(formatFromNumber(value, useGrouping))
      }}
    />
  )
}
