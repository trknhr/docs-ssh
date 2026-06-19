import './styles.css'

const copyButtons = document.querySelectorAll<HTMLButtonElement>('[data-copy]')

copyButtons.forEach((button) => {
  const originalText = button.textContent ?? 'Copy'

  button.addEventListener('click', async () => {
    const value = button.dataset.copy
    if (!value) return

    try {
      await navigator.clipboard.writeText(value)
      button.textContent = 'Copied'
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = value
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.append(textarea)
      textarea.select()
      document.execCommand('copy')
      textarea.remove()
      button.textContent = 'Copied'
    }

    window.setTimeout(() => {
      button.textContent = originalText
    }, 1400)
  })
})

const searchInput = document.querySelector<HTMLInputElement>('#site-search')
const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-section]'))
const navLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('.sidebar-nav a, .toc a'))

searchInput?.addEventListener('input', () => {
  const query = searchInput.value.trim().toLocaleLowerCase()

  sections.forEach((section) => {
    const text = section.textContent?.toLocaleLowerCase() ?? ''
    section.hidden = Boolean(query) && !text.includes(query)
  })

  navLinks.forEach((link) => {
    const target = document.querySelector<HTMLElement>(link.hash)
    link.toggleAttribute('hidden', Boolean(query) && Boolean(target?.hidden))
  })
})

const observer = new IntersectionObserver(
  (entries) => {
    const activeEntry = entries.find((entry) => entry.isIntersecting)
    if (!activeEntry) return

    const activeId = activeEntry.target.id
    navLinks.forEach((link) => {
      link.classList.toggle('active', link.hash === `#${activeId}`)
    })
  },
  {
    rootMargin: '-24% 0px -68% 0px',
    threshold: 0,
  },
)

sections.forEach((section) => observer.observe(section))
