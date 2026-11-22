import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../src/store'
import { fitWithin } from '../../src/imageResize'

const { recognizeMealPhoto, addPhotoMeal, addIntake, shrinkPhoto } = vi.hoisted(() => ({
  recognizeMealPhoto: vi.fn(),
  addPhotoMeal: vi.fn(),
  addIntake: vi.fn(),
  shrinkPhoto: vi.fn(),
}))
vi.mock('../../src/api', () => ({ recognizeMealPhoto, addPhotoMeal, addIntake }))
vi.mock('../../src/imageResize', async (orig) => ({ ...(await orig<typeof import('../../src/imageResize')>()), shrinkPhoto }))

const { default: MealModal } = await import('../../src/components/MealModal')

const small = new Blob(['jpeg'], { type: 'image/jpeg' })

function openModal() {
  useStore.setState({ mealModalOpen: true })
  render(<MemoryRouter><MealModal /></MemoryRouter>)
  return userEvent.setup()
}

const photoInput = () => screen.getByLabelText('Meal photo') as HTMLInputElement
const photoFile = () => new File(['big photo'], 'IMG_0001.jpg', { type: 'image/jpeg' })

beforeEach(() => {
  vi.clearAllMocks()
  URL.createObjectURL = vi.fn(() => 'blob:preview')
  URL.revokeObjectURL = vi.fn()
  shrinkPhoto.mockResolvedValue(small)
})

describe('Add meal from a phone photo', () => {
  it('shrinks the photo, fills the form from the AI, and saves only on Add', async () => {
    recognizeMealPhoto.mockResolvedValue({ isFood: true, foodName: 'fried rice', caloriesPer100g: 180, confidence: 'medium', estimatedGrams: 320 })
    addPhotoMeal.mockResolvedValue({ foodName: 'fried rice', calories: 540 })
    const user = openModal()

    await user.upload(photoInput(), photoFile())

    expect(shrinkPhoto).toHaveBeenCalled()
    expect(recognizeMealPhoto).toHaveBeenCalledWith(small)
    expect(await screen.findByDisplayValue('fried rice')).toBeInTheDocument()
    expect(screen.getByDisplayValue('320')).toBeInTheDocument()
    expect(screen.getByText('AI estimate — adjust')).toBeInTheDocument()
    expect(addPhotoMeal).not.toHaveBeenCalled()

    // The user corrects the portion only
    const weight = screen.getByDisplayValue('320')
    await user.clear(weight)
    await user.type(weight, '300')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(addPhotoMeal).toHaveBeenCalledWith(small, {
      foodName: 'fried rice', weightGrams: 300, caloriesPer100g: 180, confidence: 'medium', corrected: false,
    })
    expect(useStore.getState().mealModalOpen).toBe(false)
  })

  it('marks the entry corrected when the name or density changes', async () => {
    recognizeMealPhoto.mockResolvedValue({ isFood: true, foodName: 'rice', caloriesPer100g: 130, confidence: 'low', estimatedGrams: 200 })
    addPhotoMeal.mockResolvedValue({ foodName: 'egg fried rice', calories: 360 })
    const user = openModal()

    await user.upload(photoInput(), photoFile())
    const nameBox = await screen.findByDisplayValue('rice')
    expect(screen.getByText(/isn't sure/)).toBeInTheDocument()
    await user.clear(nameBox)
    await user.type(nameBox, 'egg fried rice')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(addPhotoMeal).toHaveBeenCalledWith(small, expect.objectContaining({ foodName: 'egg fried rice', corrected: true }))
  })

  it('says so when it is not food, and offers typing it in', async () => {
    recognizeMealPhoto.mockResolvedValue({ isFood: false, foodName: '', caloriesPer100g: 0, confidence: 'low', estimatedGrams: null })
    const user = openModal()

    await user.upload(photoInput(), photoFile())

    expect(await screen.findByText(/doesn't look like food/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'type it in' }))
    expect(screen.getByPlaceholderText('e.g. Toast')).toBeInTheDocument()
  })

  it('shows the server message when recognition is unavailable', async () => {
    recognizeMealPhoto.mockRejectedValue(new Error("Photo recognition isn't available right now — type the meal in instead."))
    const user = openModal()

    await user.upload(photoInput(), photoFile())

    expect(await screen.findByRole('alert')).toHaveTextContent("isn't available right now")
  })

  it('typing it in still saves without a photo', async () => {
    addIntake.mockResolvedValue({ foodName: 'Toast', calories: 159 })
    const user = openModal()

    await user.click(screen.getByRole('tab', { name: 'Type it in' }))
    await user.type(screen.getByPlaceholderText('e.g. Toast'), 'Toast')
    await user.type(screen.getByPlaceholderText('e.g. 60'), '60')
    await user.type(screen.getByPlaceholderText('e.g. 265'), '265')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(addIntake).toHaveBeenCalledWith('Toast', 60, 265)
    expect(addPhotoMeal).not.toHaveBeenCalled()
  })
})

describe('photo resizing', () => {
  it('caps the long side at 1024 px and keeps the aspect', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1024, height: 768 })
    expect(fitWithin(3024, 4032)).toEqual({ width: 768, height: 1024 })
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
  })
})
