import express from 'express'
import { 
     getPool,
      getResultWinnersByPoolName
     } from '../controllers/poolsController.js'


const poolsRouter = express.Router()

poolsRouter.get('/', getPool)
poolsRouter.get("/result/:pool_name",getResultWinnersByPoolName)


export default poolsRouter  